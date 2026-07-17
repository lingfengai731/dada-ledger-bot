import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../db/store.js';
import { extractReceipts } from '../agents/visionAgent.js';
import { parseEmployeeNotes, parseEmployeeNote } from '../agents/messageParser.js';
import { mergeToDraft, recomputeVendorDescription, matchPerson, buildReimbursementDraft, type ExpenseDraft } from '../expense.js';
import { writeExpense, archiveExpense } from '../notion/expenses.js';
import { answerQuestion } from '../agents/queryAgent.js';
import { enrichDraft, missingRequired, displayWeddingDate, displayPic } from '../schedule/enrich.js';
import { buildPeriodSummary, buildDailyDigest } from '../agents/report.js';
import { formatMoney } from '../util/money.js';
import { BALI_TZ, baliParts, baliNowText } from '../util/dates.js';
import type { Receipt, WeddingNote } from '../types.js';

const { Client, LocalAuth } = pkg;
type WAMessage = pkg.Message;
type WAChat = pkg.Chat;

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SUPPORTED_MEDIA = new Set([...SUPPORTED_IMAGE, 'application/pdf']);
// Adaptive collect window. When we're still missing half of an expense (only a
// photo, or only a note), wait for the other half to arrive. When the message is
// self-contained — photo+caption together, or a note that already follows the
// team template — process almost immediately. Tune with COLLECT_WAIT_MS.
const DEBOUNCE_MS = Number(process.env.COLLECT_WAIT_MS ?? 12 * 1000);
const QUICK_MS = 3 * 1000;
const CONFIRM_WORDS = new Set(['ok', 'okay', 'okk', 'yes', 'y', 'ya', 'yep', 'yeah', 'confirm', 'confirmed', 'oke', 'betul', 'save', 'sip', 'good']);
const CANCEL_WORDS = new Set(['cancel', 'no', 'nope', 'batal', 'skip']);

interface BufferedImage { ts: number; mimetype: string; data: string; imagePath: string; }
interface Collecting { image?: BufferedImage; noteText?: string; firstMsg: WAMessage; acked: boolean; timer: NodeJS.Timeout | null; }
interface Pending {
  /** Unique id (the triggering message id). Each submission is its OWN pending. */
  id: string;
  /** Who posted it — a sender may have several independent pendings at once. */
  sender: string;
  drafts: ExpenseDraft[];
  notes: WeddingNote[];
  receipt: Receipt | null;
  imagePath: string | null;
  ts: number;
  waMessageId: string;
  /** The chat (group) to post the auto-save / reminder back to. */
  chatId: string;
  /** true once the 30-min "please confirm" nudge has been sent (don't repeat). */
  nudged30?: boolean;
  /** id of the bot's confirm-summary message, so the nudge can quote-reply it. */
  summaryMsgId?: string;
  /** id of the 30-min reminder, so quoting that reminder + cancel targets this pending. */
  nudgeMsgId?: string;
}

// A draft nobody replied "ok" to is auto-saved after this long (boss's rule:
// don't lose expenses just because staff forgot to confirm). The clock runs from
// the last time the draft was shown or corrected.
const AUTO_WRITE_MS = 8 * 60 * 60 * 1000;
// After this long unconfirmed, @-nudge the staff who posted it (once).
const NUDGE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const collecting = new Map<string, Collecting>();
/** Open pendings keyed by their own id (NOT by sender) so one person can have
 *  several at once — each shown, confirmed, nudged and saved on its own. */
const pendingDrafts = new Map<string, Pending>();
let waClient: pkg.Client | null = null;
let pendingRestored = false;

/** Save one pending to memory + DB so it survives a restart and the sweep finds it. */
function persistPending(p: Pending): void {
  pendingDrafts.set(p.id, p);
  try {
    store.upsertPending({
      id: p.id,
      sender: p.sender,
      chatId: p.chatId,
      waMessageId: p.waMessageId,
      payloadJson: JSON.stringify(p),
      updatedAt: p.ts,
    });
  } catch (err) {
    logger.error({ err }, 'failed to persist pending draft');
  }
}

/** Drop one pending from both memory and the DB. */
function clearPending(p: Pending): void {
  pendingDrafts.delete(p.id);
  try {
    store.deletePending(p.id);
  } catch (err) {
    logger.error({ err }, 'failed to clear pending draft');
  }
}

/** Every open pending a sender has, newest last. */
function pendingsForSender(sender: string): Pending[] {
  return [...pendingDrafts.values()].filter((p) => p.sender === sender).sort((a, b) => a.ts - b.ts);
}

/** Every open pending in a chat, newest last. Used for group-wide operator actions
 * like "cancel all", and as a fallback when WhatsApp reports the same human under
 * a different sender id across devices/sessions. */
function pendingsForChat(chatId: string): Pending[] {
  return [...pendingDrafts.values()].filter((p) => p.chatId === chatId).sort((a, b) => a.ts - b.ts);
}

/** The sender's most-recently-shown pending (the default target for a correction). */
function currentPending(sender: string): Pending | null {
  const all = pendingsForSender(sender);
  return all.length ? all[all.length - 1] : null;
}

/** Re-load pendings left open before a restart so "ok" still works. Runs once. */
function restorePending(): void {
  if (pendingRestored) return;
  pendingRestored = true;
  let n = 0;
  for (const row of store.allPending()) {
    try {
      const p = JSON.parse(row.payload_json) as Pending;
      // Payloads saved before the multi-pending rework lack id/sender — the DB
      // columns are authoritative, so "ok"/corrections still find them.
      p.id = row.id;
      p.sender = row.sender;
      pendingDrafts.set(row.id, p);
      n++;
    } catch {
      store.deletePending(row.id);
    }
  }
  if (n) logger.info({ count: n }, 'restored pending drafts from DB');
}

/** Normalized boss DM ids from BOSS_WHATSAPP_ID (comma-separated numbers or *@c.us). */
function bossIds(): string[] {
  return config.summary.bossWhatsappId
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes('@') ? s : `${s.replace(/\D/g, '')}@c.us`));
}

/** DM the given text to each id. Returns how many sends succeeded. */
async function pushSummaryTo(ids: string[], text: string): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    try {
      if (!config.dryRun) await waClient?.sendMessage(id, text);
      ok++;
      logger.info({ id }, 'summary DM sent');
    } catch (err) {
      logger.error({ err, id }, 'summary DM failed');
    }
  }
  return ok;
}

const INTRO_MESSAGE = [
  "👋 Hi everyone, I'm *DADA Ledger Bot*. I log the receipts you post here so nobody has to type them into Notion by hand.",
  '',
  "Just send the receipt photo with a quick note — date, amount, who it's for. I'll read it, show you what I got, and save it once you reply *ok*. A few receipts in one message is fine too.",
  '',
  "📌 *One entry per expense.* Attach one *receipt / invoice photo*. *Start with the invoice date.* End with *for ling payment* if Ling pays the bill.",
  '',
  '*Wedding:*  _<inv date> wed <wed date> pic <name> <amount> <item> by <who paid>_',
  '   e.g. _15/6 wed 16/6 pic christi 1.500.000 bunga mitir by putu_',
  '*Shop / General:*  _<inv date> shop <amount> <item> by <who paid>_   (or *gen*)',
  '   e.g. _15/6 shop 250.000 vase stock by rania_',
  '*Reimbursement (Ling → staff):*  _reimbursement <staff name>_ + the transfer screenshot',
  '   e.g. _reimbursement putri_ — I read the amount & date from the screenshot.',
  '',
  "_Keywords: wed · pic · shop · gen · by · for ling payment_ — for weddings *wed* and *pic* are required (else you'll see *???*, just add them and reply *ok*).",
  '',
  '*Confirming:*  _ok_ = your latest one · quote one + _ok_ = that one · _ok all_ = all yours · _cancel_ / _cancel all_ = discard instead.',
  '',
  "I'm a bot, so I only jump in when there's a receipt. Chat away, I won't get in the way. Saved one by mistake? Reply */undo*. Tell me who you are once with */iam <name>* (e.g. _/iam christi_) so I credit your bills correctly. Other things: */total*, */ask*, */help*.",
  '',
  '— — — — —',
  '',
  '👋 Halo semua, saya *DADA Ledger Bot*. Saya catat nota yang kalian kirim di sini biar nggak perlu input manual ke Notion.',
  '',
  'Kirim aja foto nota plus catatan singkat — tanggal, jumlah, untuk siapa. Saya baca, tunjukkan hasilnya, lalu simpan setelah Anda balas *ok*. Boleh beberapa nota sekaligus.',
  '',
  '📌 *Satu entri per pengeluaran.* Lampirkan satu *foto nota / invoice*. *Mulai dengan tanggal invoice.* Akhiri dengan *for ling payment* kalau Ling yang bayar.',
  '',
  '*Wedding:*  _<tgl invoice> wed <tgl wedding> pic <nama> <jumlah> <barang> by <yang bayar>_',
  '   contoh: _15/6 wed 16/6 pic christi 1.500.000 bunga mitir by putu_',
  '*Shop / General:*  _<tgl invoice> shop <jumlah> <barang> by <yang bayar>_   (atau *gen*)',
  '   contoh: _15/6 shop 250.000 vase stock by rania_',
  '*Reimbursement (Ling → staf):*  _reimbursement <nama staf>_ + screenshot transfernya',
  '   contoh: _reimbursement putri_ — jumlah & tanggal saya baca dari screenshot.',
  '',
  '_Kata kunci: wed · pic · shop · gen · by · for ling payment_ — untuk wedding *wed* dan *pic* wajib (kalau tidak, muncul *???*, tambahkan lalu balas *ok*).',
  '',
  '*Konfirmasi:*  _ok_ = yang terbaru · quote satu + _ok_ = yang itu · _ok all_ = semua punyamu · _cancel_ / _cancel all_ = batalkan.',
  '',
  'Saya cuma bot, jadi saya muncul kalau ada nota aja. Santai ngobrol, nggak bakal saya ganggu. Salah simpan? Balas */undo*. Kasih tahu sekali siapa Anda dengan */iam <nama>* (mis. _/iam christi_) biar nota Anda dicatat benar. Lainnya: */total*, */ask*, */help*.',
].join('\n');

export function createBot() {
  fs.mkdirSync(config.paths.imagesDir, { recursive: true });
  restorePending();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.paths.waAuthDir }),
    puppeteer: {
      headless: config.whatsapp.headless,
      ...(config.whatsapp.executablePath ? { executablePath: config.whatsapp.executablePath } : {}),
      // Trim the headless-Chrome footprint — whatsapp-web.js keeps a full Chrome
      // running 24/7, which on a small VPS pegs CPU/RAM (Vultr flagged us for it).
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--no-first-run',
        '--js-flags=--max-old-space-size=256',
      ],
    },
  });
  waClient = client;

  let pairingAsked = false;
  client.on('qr', async (qr) => {
    // Preferred when re-linking remotely: an 8-char code typed on the phone
    // ("Link with phone number instead") — no QR scanning needed.
    const pairingCodeFile = path.join(config.paths.dataDir, 'last-pairing-code.txt');
    if (config.whatsapp.pairNumber && !pairingAsked) {
      pairingAsked = true;
      try {
        fs.rmSync(pairingCodeFile, { force: true });
        const code = await client.requestPairingCode(config.whatsapp.pairNumber);
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        fs.writeFileSync(pairingCodeFile, `${pretty}\n`);
        logger.info(
          `\n\n🔗 LINK WITH PHONE NUMBER — on the bot phone:\n` +
            `   WhatsApp → Linked devices → Link a device → "Link with phone number instead"\n` +
            `   then enter this code:        ${pretty}\n\n`,
        );
      } catch (err) {
        fs.rmSync(pairingCodeFile, { force: true });
        logger.error({ err }, 'pairing-code request failed — fall back to the QR below');
      }
    }
    logger.info('…or scan this QR (WhatsApp → Linked devices → Link a device):');
    qrcode.generate(qr, { small: true });
    // Also persist the raw QR so it can be rendered/scanned off-server when re-linking.
    try {
      fs.writeFileSync(path.join(config.paths.dataDir, 'last-qr.txt'), qr);
    } catch (err) {
      logger.warn({ err }, 'could not write last-qr.txt');
    }
  });
  client.on('auth_failure', (m) => logger.error({ m }, '🚨 WhatsApp auth failure — may need a re-scan'));
  client.on('disconnected', (r) => logger.error({ r }, '🚨 WhatsApp disconnected — bot is NOT processing messages'));

  // Heartbeat: every 5 min log the connection state, and (if HEALTHCHECK_URL is
  // set) ping it while connected so an external monitor alerts if pings stop —
  // this works even when WhatsApp/the server is down, which in-app alerts can't.
  // Self-heal: the headless-Chrome session can crash while the Node process stays
  // alive — getState() then throws, which we record as "UNREACHABLE". WhatsApp still
  // lists the device as linked, so nothing looks wrong from the phone, but the bot
  // silently stops handling messages and pm2 won't restart a process that hasn't
  // exited. After HEAL_AFTER_UNREACHABLE consecutive UNREACHABLE checks we exit(1) on
  // purpose so pm2 relaunches us; the LocalAuth session is intact, so it reconnects
  // WITHOUT a re-scan. We self-heal ONLY on UNREACHABLE (a crashed page a restart
  // fixes) — never on a genuine disconnect/unpaired state, where a restart would just
  // loop on the QR (and hammering re-links is itself a ban signal).
  const HEAL_AFTER = Math.max(1, Number(process.env.HEAL_AFTER_UNREACHABLE ?? 3));
  let lastHealthy = true;
  let unreachableStreak = 0;
  const heartbeat = setInterval(async () => {
    let state = 'UNKNOWN';
    try {
      state = (await client.getState()) ?? 'UNKNOWN';
    } catch {
      state = 'UNREACHABLE';
    }
    const healthy = state === 'CONNECTED';
    // Only the crashed-page case counts toward self-heal; any other definite state
    // (CONNECTED, UNPAIRED, …) resets the streak.
    unreachableStreak = state === 'UNREACHABLE' ? unreachableStreak + 1 : 0;

    if (healthy) {
      if (config.healthcheckUrl) {
        try {
          await fetch(config.healthcheckUrl);
        } catch (err) {
          logger.warn({ err }, 'healthcheck ping failed');
        }
      }
      // Recovered from a previous bad state → tell the boss it's back (a
      // "down" DM can't be sent while WhatsApp itself is down).
      if (!lastHealthy) {
        for (const id of bossIds()) {
          try {
            await client.sendMessage(id, `✅ DADA Ledger Bot reconnected — ${baliNowText()}.`);
          } catch {
            /* ignore */
          }
        }
        logger.info('WhatsApp recovered — boss notified');
      }
    } else {
      logger.error({ state, unreachableStreak }, '🚨 WhatsApp not connected');
      if (unreachableStreak >= HEAL_AFTER) {
        logger.error(
          { unreachableStreak, healAfter: HEAL_AFTER },
          `🔁 session unreachable ${unreachableStreak}× — exiting so pm2 restarts & reconnects (LocalAuth intact, no re-scan)`,
        );
        // Let pino flush, then exit non-zero so pm2 relaunches the process.
        setTimeout(() => process.exit(1), 500);
      }
    }
    lastHealthy = healthy;
  }, 5 * 60 * 1000);
  heartbeat.unref?.();

  // Periodic spend summary DM'd to the boss (weekly Mon / monthly 1st, Bali time).
  // Off unless BOSS_WHATSAPP_ID is set. Checked every 20 min; sent once per due day.
  let lastSummaryDate = '';
  const summaryTimer = setInterval(async () => {
    const ids = bossIds();
    if (!ids.length) return;
    const { date, hour, weekday, dayOfMonth } = baliParts();
    if (hour !== config.summary.hour) return;
    const due =
      config.summary.cadence === 'daily' ? true :
      config.summary.cadence === 'monthly' ? dayOfMonth === 1 : weekday === 1;
    if (!due || lastSummaryDate === date) return;
    lastSummaryDate = date;
    const text =
      config.summary.cadence === 'daily'
        ? buildDailyDigest()
        : buildPeriodSummary(config.summary.cadence === 'monthly' ? 30 : 7);
    await pushSummaryTo(ids, text);
  }, 20 * 60 * 1000);
  summaryTimer.unref?.();

  // Auto-write sweep: save drafts nobody confirmed after AUTO_WRITE_MS.
  const sweepTimer = setInterval(() => {
    sweepPending().catch((err) => logger.error({ err }, 'pending sweep failed'));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  client.on('ready', async () => {
    logger.info('WhatsApp client ready ✅');
    try {
      const groups = (await client.getChats()).filter((c) => c.isGroup);
      logger.info('--- Groups the bot is in (copy id into WHATSAPP_GROUP_ID) ---');
      for (const g of groups) logger.info(`  ${g.name}  ->  ${g.id._serialized}`);
      logger.info('-------------------------------------------------------------');
      logger.info(
        { dryRun: config.dryRun, notion: config.notion.writeMode, trigger: config.triggerMode, target: config.whatsapp.groupId || config.whatsapp.groupName },
        'ready',
      );
    } catch (err) {
      logger.error({ err }, 'failed to list chats');
    }
  });

  client.on('message_create', async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      logger.error({ err }, 'error handling message');
    }
  });

  client.on('group_join', async (notification) => {
    try {
      const me = client.info?.wid?._serialized;
      const added: string[] = (notification as any).recipientIds ?? [];
      if (!me || !added.includes(me)) return;
      const chat = await notification.getChat();
      const groupId = (chat as any)?.id?._serialized ?? '';
      if (config.silentIntake.sourceGroupId && groupId === config.silentIntake.sourceGroupId) {
        logger.info({ group: chat.name, groupId }, 'bot added to silent intake group - intro suppressed');
        return;
      }
      logger.info({ group: chat.name }, 'bot added to a group — introducing itself');
      if (!config.dryRun) await chat.sendMessage(INTRO_MESSAGE);
      else logger.info('\n[intro preview]\n' + INTRO_MESSAGE);
    } catch (err) {
      logger.error({ err }, 'failed to post intro');
    }
  });

  return client;
}

async function isTargetGroup(msg: WAMessage): Promise<boolean> {
  // When WHATSAPP_GROUP_ID is pinned, the incoming group id is already on
  // msg.from. Prefer this cheap check: after a fresh link WhatsApp Web can report
  // "ready" while getChat()/getChats() still throws from the page context, which
  // would otherwise make the bot ignore every valid group message.
  if (config.whatsapp.groupId) {
    return msg.from === config.whatsapp.groupId;
  }
  const chat: WAChat = await msg.getChat();
  if (!chat.isGroup) return false;
  return chat.name === config.whatsapp.groupName;
}

type MessageRoute = 'interactive' | 'silent-intake' | null;

async function messageRoute(msg: WAMessage): Promise<MessageRoute> {
  try {
    if (await isTargetGroup(msg)) return 'interactive';
  } catch (err) {
    logger.warn({ err }, 'target-group check failed');
  }
  const silent = config.silentIntake;
  if (silent.autoSave && silent.sourceGroupId && silent.auditGroupId && msg.from === silent.sourceGroupId) {
    return 'silent-intake';
  }
  return null;
}

async function handleMessage(msg: WAMessage): Promise<void> {
  if (msg.fromMe) return;
  const route = await messageRoute(msg);
  if (!route) return;
  const sender = msg.author ?? msg.from;
  if (route === 'silent-intake') {
    await handleSilentIntake(msg, sender);
    return;
  }

  if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
    await onImage(msg, sender);
    return;
  }

  const body = (msg.body ?? '').trim();
  if (!body) return;
  if (body.startsWith('/')) {
    await handleCommand(msg, body);
    return;
  }

  // Resolve a quoted message once (used for both "note quoting a photo" and
  // "ok/correction quoting a specific confirm message").
  let quoted: WAMessage | null = null;
  if (msg.hasQuotedMsg) {
    try { quoted = await msg.getQuotedMessage(); } catch (err) { logger.warn({ err }, 'could not load quoted message'); }
  }

  // Scenario 3: a note that QUOTES an earlier photo is the note FOR that photo —
  // pair them into one expense instead of recording the text on its own.
  if (quoted && !quoted.fromMe && quoted.hasMedia && (quoted.type === 'image' || quoted.type === 'document')) {
    await onQuotedImageNote(msg, sender, quoted, body);
    return;
  }

  const word = body.toLowerCase().replace(/[^a-z]/g, '');
  const wantsAll = word === 'okall' || word === 'allok' || word === 'cancelall' || word === 'allcancel';
  const chatPendings = pendingsForChat(msg.from);
  const quotedId = quoted?.id?._serialized ?? null;
  const chatTargeted = quotedId
    ? chatPendings.find((p) => p.summaryMsgId === quotedId || p.nudgeMsgId === quotedId || p.waMessageId === quotedId) ?? null
    : null;
  if (word === 'cancelall' || word === 'allcancel') {
    for (const p of chatPendings) clearPending(p);
    await reply(
      msg,
      chatPendings.length > 0
        ? `🗑️ Cancelled ${chatPendings.length} pending expense${chatPendings.length > 1 ? 's' : ''} in this chat.`
        : '🗑️ No pending expenses in this chat.',
    );
    return;
  }
  if (chatTargeted && /\bcancel\b/i.test(body)) {
    clearPending(chatTargeted);
    await reply(msg, '🗑️ Cancelled — nothing was saved.');
    return;
  }

  const pendings = pendingsForSender(sender);
  if (pendings.length) {
    // Quoting one of my confirm messages targets THAT pending; otherwise the latest.
    const targeted = quotedId
      ? pendings.find((p) => p.summaryMsgId === quotedId || p.nudgeMsgId === quotedId || p.waMessageId === quotedId) ?? null
      : null;
    const target = targeted ?? pendings[pendings.length - 1];

    // Boss's rule: a plain "ok" confirms ONLY the most recent submission (or the
    // quoted one); "ok all" / "all ok" confirms everything open. Same for cancel.
    if (CONFIRM_WORDS.has(word) || word === 'okall' || word === 'allok' || body.includes('✅')) {
      await commitPendings(msg, wantsAll ? pendings : [targeted ?? target]);
      return;
    }
    // "cancel" drops the most recent (or quoted — e.g. "Cancel unsaved expenses"
    // quoting a summary); "cancel all" drops everything open.
    if (CANCEL_WORDS.has(word)) {
      const toCancel = [target];
      for (const p of toCancel) clearPending(p);
      await reply(msg, '🗑️ Cancelled — nothing was saved.');
      return;
    }
    // "1. 130000" / "3. christi" → fix specific row(s) of the targeted set.
    if (parseTargetedLines(body, target.drafts.length).length) {
      await correctRows(msg, target, body);
      return;
    }
    // A BARE amount ("1132500" / "1.132.500") is a price fix for what's showing,
    // not a new expense — real submissions follow the template (start with a date).
    const bareAmt = body.replace(/\b(idr|rp)\b/gi, '').trim();
    if (/^\d{1,3}(?:[.,]\d{3})+$|^\d{4,}$/.test(bareAmt)) {
      const amt = Number(bareAmt.replace(/\D/g, ''));
      if (target.drafts.length === 1) {
        const d = target.drafts[0];
        if (d.isReimbursement) d.reimbursed = amt; else d.cost = amt;
        await reReply(msg, target);
      } else {
        await reply(msg, `Which one? Reply with its number, e.g. *1. ${bareAmt}*.`);
      }
      return;
    }
    // A message carrying its OWN amount/date is a NEW, separate expense → its own
    // confirmation (never merged into the one already showing).
    if (looksLikeExpense(body)) {
      await onNote(msg, sender, stripKeyword(body));
      return;
    }
    // Otherwise a bare partial fix ("christi", "wed 16/6") → fill the blanks.
    if (looksLikeCorrection(body)) {
      await correctBare(msg, target, stripKeyword(body));
    }
    return;
  }

  const alreadyCollecting = collecting.has(sender);
  const isNote =
    config.triggerMode === 'keyword'
      ? hasTrigger(body)
      : alreadyCollecting || looksLikeExpense(body) || hasTrigger(body);

  if (isNote && !CONFIRM_WORDS.has(word) && !CANCEL_WORDS.has(word)) {
    await onNote(msg, sender, stripKeyword(body));
  }
}

/** Saved-key for a message's media file (stable, derived from the message id) so
 *  a later quoted note can find the draft that this same photo produced. */
function mediaKey(messageId: string): string {
  return messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Download a message's media to disk and buffer it. Returns null if it isn't a
 *  supported image/PDF or the download fails (so a quoted note still falls back
 *  to a plain note instead of throwing). */
async function bufferMedia(m: WAMessage): Promise<BufferedImage | null> {
  const waits = [0, 1500, 4000];
  let lastErr: unknown = null;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await sleep(waits[i]);
    try {
      const media = await m.downloadMedia();
      if (!media || !SUPPORTED_MEDIA.has(media.mimetype)) return null;
      const ext = media.mimetype === 'application/pdf' ? 'pdf' : (media.mimetype.split('/')[1] ?? 'jpg');
      const imagePath = path.join(config.paths.imagesDir, `${mediaKey(m.id._serialized)}.${ext}`);
      fs.writeFileSync(imagePath, Buffer.from(media.data, 'base64'));
      return { ts: Date.now(), mimetype: media.mimetype, data: media.data, imagePath };
    } catch (err) {
      lastErr = err;
      logger.warn({ err, attempt: i + 1, attempts: waits.length }, 'media download attempt failed');
    }
  }
  logger.warn({ err: lastErr }, 'media download failed');
  return null;
}

async function onImage(msg: WAMessage, sender: string): Promise<void> {
  const caption = (msg.body ?? '').trim();
  const img = await bufferMedia(msg);
  if (!img) {
    // If WhatsApp Web cannot download the image but staff included the required
    // note as a caption, keep the workflow moving as a text-only expense instead
    // of silently dropping the submission.
    if (caption && looksLikeExpense(caption)) {
      await onNote(msg, sender, stripKeyword(caption));
    } else if (caption) {
      logger.warn({ caption }, 'media download failed; caption did not look like an expense');
    } else {
      await reply(msg, '⚠️ I could not download this receipt image. Please resend it, or send the expense details as text.');
    }
    return;
  }
  const imagePath = img.imagePath;

  // Staff usually post the photo WITH a caption ("0617 kyea ... trf ling"). That
  // caption is the note — capture it, or it's silently lost and the expense is
  // read from the image alone (wrong category/PIC/description).

  // A late receipt photo for the one expense we just showed (text first, photo
  // after the collect window) → attach it to that draft and re-derive. A photo
  // WITH its own caption, or when several expenses are pending, is a new expense
  // and gets collected below.
  const pending = currentPending(sender);
  if (pending && pending.drafts.length === 1 && !pending.drafts[0].imagePath && !pending.drafts[0].isReimbursement && !caption) {
    const receipt = await readReceipt(img);
    const note = pending.notes[0] ?? EMPTY_NOTE;
    pending.drafts[0] = mergeToDraft(note, receipt, imagePath, pending.drafts[0].handler);
    enrichDraft(pending.drafts[0]);
    await reReply(msg, pending);
    return;
  }

  const c = getCollecting(sender, msg);
  c.image = img;
  if (caption) c.noteText = c.noteText ? `${c.noteText} ${caption}` : caption;
  schedule(sender);
}

/** A text note that quotes an earlier photo. Three cases, in order:
 *  (a) that photo is still being collected → add the note to it (= scenario 4);
 *  (b) that photo already became a draft → the note is its details, enrich it;
 *  (c) otherwise → download the quoted photo and build one expense from photo+note. */
async function onQuotedImageNote(msg: WAMessage, sender: string, quoted: WAMessage, note: string): Promise<void> {
  const c = collecting.get(sender);
  if (c?.image) {
    c.noteText = c.noteText ? `${c.noteText} ${note}` : note;
    schedule(sender);
    return;
  }

  const key = mediaKey(quoted.id._serialized);
  for (const p of pendingsForSender(sender)) {
    const draft = p.drafts.find((d) => d.imagePath?.includes(key));
    if (draft) {
      const follow = await parseEmployeeNote(note);
      if (applyCorrection(draft, follow)) {
        enrichDraft(draft);
        await reReply(msg, p);
      }
      return;
    }
  }

  const img = await bufferMedia(quoted);
  if (!img) { await onNote(msg, sender, stripKeyword(note)); return; }
  if (note && isReimbursementText(note)) { await buildReimbursement(msg, sender, note, img); return; }
  const notes = note ? await parseEmployeeNotes(note) : [{ ...EMPTY_NOTE }];
  const receipt = await readReceipt(img);
  await finalize(msg, sender, notes, receipt, img.imagePath, []);
}

async function onNote(msg: WAMessage, sender: string, text: string): Promise<void> {
  if (!text) return;
  // Buffer the note; the debounce window pairs it with a photo if one is coming,
  // then buildFromCollection → finalize, which ADDS it to any running set.
  const c = getCollecting(sender, msg);
  c.noteText = c.noteText ? `${c.noteText} ${text}` : text;
  schedule(sender);
}

/** Channel 2: read the real group silently, write complete expenses directly,
 *  and report only to the audit/test group. */
async function handleSilentIntake(msg: WAMessage, sender: string): Promise<void> {
  if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
    await onSilentImage(msg, sender);
    return;
  }

  const body = (msg.body ?? '').trim();
  if (!body || body.startsWith('/')) return;
  const word = body.toLowerCase().replace(/[^a-z]/g, '');
  if (CONFIRM_WORDS.has(word) || CANCEL_WORDS.has(word)) return;

  const isNote = config.triggerMode === 'keyword'
    ? hasTrigger(body)
    : looksLikeExpense(body) || hasTrigger(body);
  if (!isNote) return;
  await buildSilentFromCollection(msg, sender, stripKeyword(body), null);
}

async function onSilentImage(msg: WAMessage, sender: string): Promise<void> {
  const caption = (msg.body ?? '').trim();
  const img = await bufferMedia(msg);
  if (!img && !caption) {
    await notifySilentAudit(msg, 'Not saved - image could not be downloaded, and no caption was available.');
    return;
  }
  if (!img && caption && !looksLikeExpense(caption)) {
    await notifySilentAudit(msg, 'Not saved - image could not be downloaded, and the caption did not look like an expense.');
    return;
  }
  await buildSilentFromCollection(msg, sender, stripKeyword(caption), img);
}

async function buildSilentFromCollection(
  msg: WAMessage,
  sender: string,
  noteText: string,
  img: BufferedImage | null,
): Promise<void> {
  const note = noteText.trim();
  if (!note) {
    await notifySilentAudit(msg, 'Not saved - add a caption/text note before silent auto-save.');
    return;
  }
  if (isReimbursementText(note)) {
    const drafts = img
      ? await reimbursementDraftsFromImage(note, img)
      : [await reimbursementDraftFromText(note)];
    await saveSilentDrafts(msg, sender, drafts, [], null, img?.imagePath ?? null);
    return;
  }

  const notes = note ? await parseEmployeeNotes(note) : [{ ...EMPTY_NOTE }];
  let receipt: Receipt | null = null;
  const extra: string[] = [];
  if (img) {
    receipt = await readReceipt(img);
    if (!receipt) extra.push('Could not read the receipt image clearly.');
  } else {
    extra.push('No photo attached - recorded from the note only.');
  }
  const drafts = await buildDrafts(msg, notes, receipt, img?.imagePath ?? null, extra);
  await saveSilentDrafts(msg, sender, drafts, notes, receipt, img?.imagePath ?? null);
}

async function reimbursementDraftsFromImage(noteText: string, img: BufferedImage): Promise<ExpenseDraft[]> {
  const transfers = await extractReceipts(img.data, img.mimetype, 'reimbursement');
  const typedName = noteText.replace(/.*\breimburse(ment|d)?\b/i, '').trim() || null;
  const drafts = transfers.length
    ? transfers.map((t) =>
        buildReimbursementDraft(
          transfers.length === 1 && typedName ? typedName : t.recipient,
          t.total,
          img.imagePath,
          noteText,
          t.date ?? null,
        ),
      )
    : [buildReimbursementDraft(typedName, null, img.imagePath, noteText)];
  if (!transfers.length) drafts[0].warnings.push('Could not read any transfer in the screenshot - please check.');
  return drafts;
}

async function reimbursementDraftFromText(noteText: string): Promise<ExpenseDraft> {
  const name = noteText.match(/\breimburse(?:ment|d)?\b\s*(?:to\s+)?([a-z][a-z'.-]*)/i)?.[1] ?? null;
  const note = await parseEmployeeNote(noteText);
  const draft = buildReimbursementDraft(name, note.amount, null, noteText, note.invoiceDate);
  draft.warnings.push('No transfer screenshot attached - recorded from the note only.');
  return draft;
}

async function saveSilentDrafts(
  msg: WAMessage,
  sender: string,
  drafts: ExpenseDraft[],
  notes: WeddingNote[],
  receipt: Receipt | null,
  imagePath: string | null,
): Promise<void> {
  const complete = drafts.filter((d) => missingRequired(d).length === 0);
  const blocked = drafts
    .map((d, i) => ({ i, draft: d, missing: missingRequired(d) }))
    .filter((x) => x.missing.length);

  let savedCount = 0;
  let savedToNotion = 0;
  if (complete.length) {
    const pending: Pending = {
      id: `${msg.id._serialized}:silent`,
      sender,
      drafts: complete,
      notes,
      receipt,
      imagePath,
      ts: Date.now(),
      waMessageId: msg.id._serialized,
      chatId: config.silentIntake.auditGroupId,
    };
    const result = await savePending(pending, sender);
    savedCount = result.count;
    savedToNotion = result.savedToNotion;
  }

  const lines: string[] = [];
  if (savedCount) {
    lines.push(savedToNotion > 0 ? `${messageTimeLabel(msg)} Saved to Notion.` : `${messageTimeLabel(msg)} Recorded. (Notion preview mode - not written yet.)`);
  }
  for (const b of blocked) {
    const label = drafts.length > 1 ? ` ${b.i + 1}.` : '';
    const what = b.draft.vendorDescription ?? 'expense';
    lines.push(`${messageTimeLabel(msg)} Not saved${label} - ${what} needs ${b.missing.join(' / ')}.`);
  }
  if (!lines.length) lines.push(`${messageTimeLabel(msg)} Not saved - no expense draft was created.`);

  await notifySilentAudit(msg, lines.join('\n'));
  logger.info({ source: msg.from, audit: config.silentIntake.auditGroupId, savedCount, savedToNotion, blocked: blocked.length }, 'silent intake processed');
}

async function notifySilentAudit(msg: WAMessage, text: string): Promise<void> {
  if (!config.silentIntake.auditGroupId) return;
  // WhatsApp cannot quote a message from a different group, so keep the audit
  // notice as plain text with the source message timestamp.
  await sendToChat(config.silentIntake.auditGroupId, text, '[silent-intake preview]');
}

function messageTimeLabel(msg: WAMessage): string {
  const ts = typeof msg.timestamp === 'number' ? msg.timestamp * 1000 : Date.now();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BALI_TZ,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Post/repost a pending's confirm summary, @-tagging the submitter so they get a
 *  notification to reply ok (boss: "tag the one who sent it to remind them"). */
async function postSummary(msg: WAMessage, pending: Pending): Promise<void> {
  const text = `${renderSummary(pending.drafts)}\n\n@${pending.sender.split('@')[0]}`;
  const sent = await reply(msg, text, [pending.sender]);
  if (sent) { pending.summaryMsgId = sent.id._serialized; persistPending(pending); }
}

/** Persist the (mutated) pending and re-post its summary. */
async function reReply(msg: WAMessage, pending: Pending): Promise<void> {
  pending.ts = Date.now();
  persistPending(pending);
  await postSummary(msg, pending);
}

/** Pull "N. <fix>" lines out of a correction to a multi-expense batch. Matches
 *  "1. 130000", "#1 christi", "no 1 …", "item 3 …", "1) …" — one per line, and
 *  tolerates the bot's own *bold* markdown when staff copy a line back. Only
 *  indices within the batch are returned (0-based). */
function parseTargetedLines(text: string, count: number): { idx: number; rest: string }[] {
  const out: { idx: number; rest: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\*/g, '').trim();
    // Row marker is EITHER a "#/no/item" prefix + number, OR a number followed by
    // a "." ")" ":" "-" AND a space. The trailing space matters: "1. 130000" is a
    // row marker, but "1.000.000 bunga" (an Indonesian amount) is NOT.
    const m = line.match(/^(?:(?:#|no\.?|item)\s*(\d{1,2})|(\d{1,2})\s*[.):\-]\s+)(.+\S)\s*$/i);
    if (!m) continue;
    const idx = Number(m[1] ?? m[2]);
    if (idx >= 1 && idx <= count) out.push({ idx: idx - 1, rest: m[3].trim() });
  }
  return out;
}

/** Numbered fixes ("1. 130000", "3. christi") → patch just those row(s). */
async function correctRows(msg: WAMessage, pending: Pending, text: string): Promise<void> {
  const targeted = parseTargetedLines(text, pending.drafts.length);
  let any = false;
  for (const { idx, rest } of targeted) {
    const follow = await parseEmployeeNote(rest);
    if (applyCorrection(pending.drafts[idx], follow)) { enrichDraft(pending.drafts[idx]); any = true; }
  }
  if (any) await reReply(msg, pending);
  else await reply(msg, '👍 Nothing changed there — reply *ok* to save, or e.g. *1. 130000*.');
}

/** A bare partial fix ("christi", "wed 16/6") with no row number. Fill it into
 *  every row that's MISSING that field (e.g. one "christi" sets PIC for all the
 *  rows still lacking one). For a single pending row, also allow overriding. */
async function correctBare(msg: WAMessage, pending: Pending, text: string): Promise<void> {
  const follow = await parseEmployeeNote(text);
  let any = false;
  for (const d of pending.drafts) {
    if (applyMissing(d, follow)) { enrichDraft(d); any = true; }
  }
  if (!any && pending.drafts.length === 1) {
    if (applyCorrection(pending.drafts[0], follow)) { enrichDraft(pending.drafts[0]); any = true; }
  }
  if (any) await reReply(msg, pending);
  else if (pending.drafts.length > 1) {
    await reply(msg, `That set has *${pending.drafts.length}* expenses — which one? Reply with its number, e.g. *1. ${text}*.`);
  }
}

/** Like applyCorrection but only fills fields that are currently EMPTY (used for a
 *  bare fix applied across a batch, so it never clobbers a value already set). */
function applyMissing(draft: ExpenseDraft, c: WeddingNote): boolean {
  let changed = false;
  const fill = <T,>(cur: T, next: T): T => {
    if (cur == null && next != null) { changed = true; return next; }
    return cur;
  };
  draft.weddingDate = fill(draft.weddingDate, c.weddingDate);
  draft.invoiceDate = fill(draft.invoiceDate, c.invoiceDate);
  draft.pic = fill(draft.pic, c.pic);
  draft.location = fill(draft.location, c.location);
  draft.handler = fill(draft.handler, c.buyer);
  if (changed && (c.weddingDate || c.pic)) draft.isWedding = true;
  return changed;
}

/** Overlay corrective fields from a follow-up note onto an existing draft.
 *  Returns true if anything actually changed (so we only re-reply when it did). */
function applyCorrection(draft: ExpenseDraft, c: WeddingNote): boolean {
  let changed = false;
  const set = <T,>(cur: T, next: T): T => {
    if (next != null && next !== cur) changed = true;
    return next != null ? next : cur;
  };
  draft.weddingDate = set(draft.weddingDate, c.weddingDate);
  draft.invoiceDate = set(draft.invoiceDate, c.invoiceDate);
  draft.pic = set(draft.pic, c.pic);
  draft.location = set(draft.location, c.location);
  draft.handler = set(draft.handler, c.buyer);
  if (c.description && c.description !== draft.description) {
    draft.description = c.description;
    recomputeVendorDescription(draft);
    changed = true;
  }
  if (c.amount != null && c.amount !== draft.cost) {
    draft.cost = c.amount;
    changed = true;
  }
  // Type fixes. Only CONCRETE wedding signals (a wed date / a pic) flip to WEDDING —
  // not the parser's default category, or a bare "1. 130000" amount fix could flip a
  // SHOP draft. An explicit "shop"/"gen" word in the reply flips the type the other
  // way (how staff correct a wrong auto-classification shown in the header).
  const typeWord = c.rawText.match(/\b(shop|gen(?:eral)?)\b/i)?.[1]?.toLowerCase() ?? null;
  if (typeWord && !c.weddingDate && !c.pic) {
    const t = typeWord === 'shop' ? ('shop' as const) : ('general' as const);
    if (draft.isWedding || draft.expenseType !== t) changed = true;
    draft.isWedding = false;
    draft.expenseType = t;
  } else if (c.weddingDate || c.pic) {
    if (!draft.isWedding) changed = true;
    draft.isWedding = true;
    draft.expenseType = 'wedding';
  }
  return changed;
}

function getCollecting(sender: string, msg: WAMessage): Collecting {
  let c = collecting.get(sender);
  if (!c) {
    c = { firstMsg: msg, acked: false, timer: null };
    collecting.set(sender, c);
  }
  return c;
}

/** A note that already follows the team template (invoice date first + a type
 *  keyword) is self-contained — no need to wait for a photo before replying.
 *  If a photo does arrive later, the late-photo path attaches it to the draft. */
function isTemplateNote(text: string | undefined): boolean {
  if (!text) return false;
  return /^\s*\d{1,2}\s*[\/.\-]\s*\d{1,2}\s+.*\b(wed|shop|gen|general|reimburse\w*)\b/i.test(text.trim());
}

function schedule(sender: string): void {
  const c = collecting.get(sender);
  if (!c) return;
  if (c.timer) clearTimeout(c.timer);
  // Photo+note together, or a template-format note? Self-contained → respond
  // fast. Otherwise keep waiting for the missing half.
  const complete = (Boolean(c.image) && Boolean(c.noteText && c.noteText.trim())) || isTemplateNote(c.noteText);
  const delay = complete ? QUICK_MS : DEBOUNCE_MS;
  c.timer = setTimeout(() => {
    collecting.delete(sender);
    buildFromCollection(c.firstMsg, sender, c.noteText ?? '', c.image ?? null).catch((err) =>
      logger.error({ err }, 'build failed'),
    );
  }, delay);
}

const EMPTY_NOTE: WeddingNote = {
  category: 'general', isWedding: false, invoiceDate: null, weddingDate: null, pic: null,
  organiser: null, location: null, buyer: null, description: null, amount: null,
  rawText: '', confidence: 0, notes: null,
};

async function readReceipt(img: BufferedImage): Promise<Receipt | null> {
  const receipts = await extractReceipts(img.data, img.mimetype);
  return receipts[0] ?? null;
}

/** A "Reimbursement …" note means Ling is paying a staff member back. */
function isReimbursementText(text: string): boolean {
  return /\breimburse(ment|d)?\b/i.test(text);
}

async function buildFromCollection(
  msg: WAMessage,
  sender: string,
  noteText: string,
  img: BufferedImage | null,
): Promise<void> {
  // Reimbursement: read the bank-transfer screenshot(s); each transfer = one row
  // with the amount in REIMBURSED (no COST / wedding / PIC). Works text-only too
  // ("14/6 reimbursement to putri 50000") — amount/date from the note then.
  if (isReimbursementText(noteText)) {
    if (img) await buildReimbursement(msg, sender, noteText, img);
    else await buildReimbursementFromText(msg, sender, noteText);
    return;
  }

  const notes = noteText.trim() ? await parseEmployeeNotes(noteText) : [{ ...EMPTY_NOTE }];
  let receipt: Receipt | null = null;
  const extra: string[] = [];
  if (img) {
    receipt = await readReceipt(img);
    if (!receipt) extra.push('Could not read the receipt image clearly.');
  } else {
    extra.push('No photo attached — recorded from your note only.');
  }
  await finalize(msg, sender, notes, receipt, img?.imagePath ?? null, extra);
}

/** Build reimbursement draft(s) from a transfer screenshot + "Reimbursement <name>" note. */
async function buildReimbursement(
  msg: WAMessage,
  sender: string,
  noteText: string,
  img: BufferedImage,
): Promise<void> {
  const transfers = await extractReceipts(img.data, img.mimetype, 'reimbursement');
  // A name typed after "Reimbursement" (e.g. "Reimbursement Christi") overrides the
  // transfer's "To" name when there's exactly one transfer.
  const typedName = noteText.replace(/.*\breimburse(ment|d)?\b/i, '').trim() || null;
  const drafts = transfers.length
    ? transfers.map((t) =>
        buildReimbursementDraft(
          transfers.length === 1 && typedName ? typedName : t.recipient,
          t.total,
          img.imagePath,
          noteText,
          t.date ?? null, // invoice date from the transfer image; else entry date
        ),
      )
    : [buildReimbursementDraft(typedName, null, img.imagePath, noteText)];
  if (!transfers.length) drafts[0].warnings.push('Could not read any transfer in the screenshot — please check.');

  await showNewPending(msg, sender, drafts, [], null, img.imagePath);
}

/** Reimbursement typed WITHOUT a screenshot, e.g. "14/6 reimbursement to putri 50000".
 *  Name from the words after "reimbursement (to)", amount/date parsed from the note
 *  (date falls back to the day it was posted). */
async function buildReimbursementFromText(msg: WAMessage, sender: string, noteText: string): Promise<void> {
  const name = noteText.match(/\breimburse(?:ment|d)?\b\s*(?:to\s+)?([a-z][a-z'.-]*)/i)?.[1] ?? null;
  const note = await parseEmployeeNote(noteText);
  const draft = buildReimbursementDraft(name, note.amount, null, noteText, note.invoiceDate);
  draft.warnings.push('No transfer screenshot attached — recorded from your note only.');
  await showNewPending(msg, sender, [draft], [], null, null);
}

/** The sender's WhatsApp display name (used to infer the handler in the real group). */
async function resolveSenderName(msg: WAMessage): Promise<string | null> {
  try {
    const c = await msg.getContact();
    return (c?.pushname || (c as any)?.name || c?.shortName || null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve who posted the bill to a known DADA person. Uses the learned staff map
 * first (stable across display-name changes), then falls back to matching their
 * WhatsApp display name — and remembers it when that match succeeds, so the bot
 * gets better at recognising each colleague over time. Returns the canonical
 * person if known, else the raw display name for pickHandler to try.
 */
async function resolveSenderPerson(msg: WAMessage): Promise<string | null> {
  const id = msg.author ?? msg.from;
  const mapped = store.getStaffPerson(id);
  if (mapped) return mapped;
  const name = await resolveSenderName(msg);
  const person = matchPerson(name);
  if (person) {
    if (store.setStaffPerson(id, person, 'auto')) logger.info({ id, person }, 'learned sender → person');
    return person;
  }
  return name;
}

async function finalize(
  msg: WAMessage,
  sender: string,
  notes: WeddingNote[],
  receipt: Receipt | null,
  imagePath: string | null,
  extraWarnings: string[],
): Promise<void> {
  const drafts = await buildDrafts(msg, notes, receipt, imagePath, extraWarnings);
  await showNewPending(msg, sender, drafts, notes, receipt, imagePath);
}

async function buildDrafts(
  msg: WAMessage,
  notes: WeddingNote[],
  receipt: Receipt | null,
  imagePath: string | null,
  extraWarnings: string[],
): Promise<ExpenseDraft[]> {
  // Whoever posts the bill is usually the handler — resolve to a known person
  // (via the learned staff map, growing as colleagues post).
  const senderName = await resolveSenderPerson(msg);

  // A photo with a SINGLE typed expense: its printed total is authoritative, so
  // mergeToDraft reconciles note-vs-receipt. But a MULTI-line list already states
  // each amount — the photo is only proof, so attach it to the matching line (or
  // the first) and never let it override a typed amount. Fixes "breakfast 130000
  // shown as 300000" when one receipt rode along with a typed list.
  const multi = notes.length > 1;
  let photoLine = 0;
  if (multi && receipt?.total != null) {
    const m = notes.findIndex((n) => n.amount === receipt.total);
    photoLine = m >= 0 ? m : 0;
  }
  const drafts = notes.map((n, i) => {
    const useReceipt = multi ? null : i === 0 ? receipt : null;
    const attach = i === photoLine ? imagePath : null;
    const d = mergeToDraft(n, useReceipt, attach, senderName);
    if (i === 0) d.warnings.push(...extraWarnings);
    if (multi && imagePath && i === photoLine) d.info.push('📎 Receipt photo attached here (kept your typed amounts).');
    // Fill missing wedding date / PIC from the schedule + recent context.
    enrichDraft(d);
    // Warn if this looks like an already-recorded receipt (same amount+date+item).
    const dup = store.findDuplicateExpense({
      cost: d.cost,
      invoiceDate: d.invoiceDate,
      vendorDescription: d.vendorDescription,
    });
    if (dup) {
      const when = new Date(dup.created_at).toISOString().slice(0, 10);
      d.warnings.push(`Possible duplicate — "${dup.vendor_description}" for the same amount & date was already saved on ${when}. Reply *ok* to save anyway.`);
    }
    return d;
  });
  return drafts;
}

/** Show a freshly-built submission as its OWN independent pending (one message →
 *  one confirmation). Separate submissions are never merged, so each is confirmed,
 *  nudged and saved on its own. */
async function showNewPending(
  msg: WAMessage,
  sender: string,
  drafts: ExpenseDraft[],
  notes: WeddingNote[],
  receipt: Receipt | null,
  imagePath: string | null,
): Promise<void> {
  const pending: Pending = {
    id: msg.id._serialized, sender, drafts, notes, receipt, imagePath,
    ts: Date.now(), waMessageId: msg.id._serialized, chatId: msg.from,
  };
  persistPending(pending);
  await postSummary(msg, pending);
}

/** Confirm one or more pendings. A draft still missing its wedding date / PIC is
 *  held back (and listed) instead of saved. No TOTAL here — that's a daily-summary
 *  thing, not a per-expense confirmation. */
async function commitPendings(msg: WAMessage, pendings: Pending[]): Promise<void> {
  let savedToNotion = 0;
  let savedCount = 0;
  const savedPendings: Pending[] = [];
  const blockedLines: string[] = [];
  for (const pending of pendings) {
    // Boss's rule: a wedding expense must have BOTH a wedding date and a PIC.
    const blocked = pending.drafts
      .map((d, i) => ({ i, missing: missingRequired(d) }))
      .filter((x) => x.missing.length);
    if (blocked.length) {
      pending.ts = Date.now(); // keep it alive so they can correct it
      persistPending(pending);
      for (const b of blocked) {
        const label = pending.drafts.length > 1 ? `*${b.i + 1}.* ` : '';
        const what = pending.drafts[b.i].vendorDescription ?? 'expense';
        blockedLines.push(`${label}${what} — needs *${b.missing.join('* & *')}*`);
      }
      continue;
    }
    clearPending(pending);
    const r = await savePending(pending, pending.sender);
    savedToNotion += r.savedToNotion;
    savedCount += r.count;
    savedPendings.push(pending);
  }

  if (savedCount > 0) {
    // Boss: keep it to a plain "Saved" — no count. Quote each ORIGINAL submission
    // so it's unambiguous which entry was recorded (tap to jump back to it).
    const text = savedToNotion > 0 ? '✅ Saved to Notion.' : '✅ Recorded. _(Notion preview mode — not written yet.)_';
    for (const p of savedPendings) {
      await sendSavedReceipt(msg, p, text);
    }
  }
  if (blockedLines.length) {
    await reply(msg, ['🚫 *Not saved yet — missing required info:*', ...blockedLines,
      '', 'Reply with the missing detail (e.g. _16/06 christi_), then *ok* — or quote the one you want to drop and reply *cancel*.'].join('\n'));
  }
}

async function sendSavedReceipt(msg: WAMessage, pending: Pending, text: string): Promise<void> {
  const strictQuote = { ignoreQuoteErrors: false, waitUntilMsgSent: true };
  const original = await sendToChat(pending.chatId, text, '[saved receipt preview]', {
    quotedMessageId: pending.waMessageId,
    ...strictQuote,
  });
  if (original) return;

  if (pending.summaryMsgId && pending.summaryMsgId !== pending.waMessageId) {
    const summary = await sendToChat(pending.chatId, text, '[saved receipt summary-quote fallback]', {
      quotedMessageId: pending.summaryMsgId,
      ...strictQuote,
    });
    if (summary) return;
  }

  logger.warn(
    { pendingId: pending.id, waMessageId: pending.waMessageId, summaryMsgId: pending.summaryMsgId },
    'saved receipt could not quote original or summary; falling back to ok reply',
  );
  await reply(msg, text);
}

/** Write every draft in a pending set to Notion + the local store. Shared by the
 *  manual "ok" path and the 8-hour auto-write sweep. */
async function savePending(pending: Pending, sender: string): Promise<{ savedToNotion: number; total: number; count: number }> {
  let savedToNotion = 0;
  let total = 0;
  for (const draft of pending.drafts) {
    const result = await writeExpense(draft);
    if (result.written) savedToNotion++;
    store.insertExpense({
      waMessageId: pending.waMessageId,
      submitter: sender,
      vendorDescription: draft.vendorDescription,
      weddingDate: draft.weddingDate,
      invoiceDate: draft.invoiceDate,
      cost: draft.cost,
      reimbursed: draft.reimbursed,
      pic: draft.pic,
      handler: draft.handler,
      isWedding: draft.isWedding,
      imagePath: draft.imagePath,
      rawNote: draft.rawNote,
      notionPageId: result.pageId,
    });
    total += draft.cost ?? draft.reimbursed ?? 0;
  }
  return { savedToNotion, total, count: pending.drafts.length };
}

/**
 * Periodically save drafts nobody confirmed. A draft that still has everything it
 * needs (no ???) is written after AUTO_WRITE_MS and announced in the group. A draft
 * still missing required fields can't be saved — we nudge once and leave it.
 */
async function sweepPending(): Promise<void> {
  const now = Date.now();
  for (const row of store.pendingOlderThan(now - NUDGE_MS)) {
    if (!pendingDrafts.has(row.id)) continue;
    let pending: Pending;
    try {
      pending = JSON.parse(row.payload_json) as Pending;
    } catch {
      store.deletePending(row.id);
      continue;
    }
    pending.id = row.id;          // columns are authoritative (older payloads lack these)
    pending.sender = row.sender;
    const age = now - row.updated_at;

    // ── 8h: auto-save complete drafts; nudge blocked ones once. ──
    if (age >= AUTO_WRITE_MS) {
      if (!pendingDrafts.has(row.id)) continue;
      const stillMissing = pending.drafts.some((d) => missingRequired(d).length);
      if (stillMissing) {
        if (!row.reminded) {
          const text =
            '⏰ Reminder: a receipt is still waiting on its *wedding date* / *PIC* before I can save it. ' +
            'Please reply with the missing detail, then *ok*.';
          await sendToChat(row.chat_id, text, '[auto-reminder preview]');
          store.markPendingReminded(row.id);
        }
        continue;
      }
      clearPending(pending);
      const { savedToNotion, count } = await savePending(pending, row.sender);
      const items = pending.drafts
        .map((d) => `• ${d.vendorDescription ?? '???'} — ${formatMoney(d.cost)}`)
        .join('\n');
      const where = savedToNotion > 0 ? 'to Notion' : '(preview mode — not written to Notion)';
      await sendToChat(
        row.chat_id,
        `⏱️ Auto-saved ${count} expense${count > 1 ? 's' : ''} ${where} after 8h with no *ok* reply:\n` +
          `${items}\nReply */undo* if any of these is wrong.`,
        '[auto-save preview]',
      );
      logger.info({ sender: row.sender, count, savedToNotion }, 'auto-saved pending drafts after grace period');
      continue;
    }

    // ── 30 min: @-nudge the staff who posted it, once. ──
    if (!pending.nudged30) {
      if (!pendingDrafts.has(row.id)) continue;
      await sendNudge(row.sender, row.chat_id, pending);
      pending.nudged30 = true;
      store.updatePendingPayload(row.id, JSON.stringify(pending));
    }
  }
}

/** A short, randomized, length-scaled "typing" beat (ms) — makes replies look
 *  human rather than instant. Capped so it doesn't undo the speed pass. */
function humanDelayMs(text: string): number {
  const raw = (1200 + Math.min(text.length, 300) * 20) * (0.7 + Math.random() * 0.6);
  return Math.round(Math.min(raw, 6000));
}

/** Before sending a group message: mark seen + show "typing…" + pause a human
 *  beat. Best-effort presence only — never throws, never affects parsing. The
 *  send itself clears the typing state. Skip entirely when HUMANIZE_REPLIES=false. */
async function humanizeBefore(chat: WAChat | null | undefined, text: string): Promise<void> {
  if (!config.humanizeReplies || !chat) return;
  try {
    await chat.sendSeen();
    await chat.sendStateTyping();
    await new Promise((r) => setTimeout(r, humanDelayMs(text)));
  } catch {
    /* presence is cosmetic — ignore and just send */
  }
}

/** Send to a chat (respecting dry-run), logging a preview when dry. */
async function sendToChat(chatId: string, text: string, previewLabel: string, opts?: object): Promise<WAMessage | null> {
  try {
    if (!config.dryRun) {
      const chat = waClient ? await waClient.getChatById(chatId).catch(() => null) : null;
      await humanizeBefore(chat, text);
      return (await waClient?.sendMessage(chatId, text, opts as any)) ?? null;
    } else logger.info(`\n${previewLabel}\n` + text);
  } catch (err) {
    logger.error({ err, chatId }, 'sendToChat failed');
  }
  return null;
}

/** Remind the staff member who posted an unconfirmed expense, @-mentioning them. */
async function sendNudge(sender: string, chatId: string, pending: Pending): Promise<void> {
  const number = sender.split('@')[0];
  const n = pending.drafts.length;
  const total = pending.drafts.reduce((s, d) => s + (d.cost ?? d.reimbursed ?? 0), 0);
  // Name the whole outstanding set, not just the first item (the old nudge only
  // mentioned drafts[0], so a batch looked like a single expense).
  const what = n > 1
    ? `your *${n} expenses* (total ${formatMoney(total)} ${config.currency})`
    : `*${pending.drafts[0]?.vendorDescription ?? 'this expense'}*`;
  const missing = [...new Set(pending.drafts.flatMap((d) => missingRequired(d)))];
  const text = missing.length
    ? `⏰ @${number} I still need the *${missing.join('* & *')}* for ${what} before I can save. Reply with it, then *ok*.`
    : `⏰ @${number} please confirm ${what} — reply *ok* to save all, or send a correction.`;
  // Quote the original confirm message so staff can tap to jump back to it.
  const opts: { mentions: string[]; quotedMessageId?: string } = { mentions: [sender] };
  const quote = pending.summaryMsgId ?? pending.waMessageId;
  if (quote) opts.quotedMessageId = quote;
  const sent = await sendToChat(chatId, text, '[nudge preview]', opts);
  if (sent) pending.nudgeMsgId = sent.id._serialized;
}

function renderSummary(drafts: ExpenseDraft[]): string {
  if (drafts.length === 1) return renderOne(drafts[0]);

  // Only happens for a burst sent together (one message / rapid run). No TOTAL —
  // totals belong only in the nightly summary DM to the boss, not in the group.
  const lines: string[] = [`🧾 *Please confirm these ${drafts.length} expenses:*`, ''];
  drafts.forEach((d, i) => {
    if (d.isReimbursement) {
      lines.push(`*${i + 1}.* ${d.vendorDescription ?? '???'} — ${formatMoney(d.reimbursed)} _(reimbursement)_`);
      return;
    }
    const inv = d.invoiceDate ? `inv ${d.invoiceDate}` : 'inv —';
    // Type is visible per line (WED with its date/PIC; SHOP/GENERAL named) so a
    // wrong auto-classification is caught before saving.
    const tag = d.isWedding
      ? `${inv} · wed ${displayWeddingDate(d)} · ${displayPic(d)}`
      : `${inv} · ${d.expenseType.toUpperCase()}`;
    const ling = d.forLingPayment ? ' 💰(Ling to pay)' : '';
    lines.push(`*${i + 1}.* ${d.vendorDescription ?? '???'} — ${formatMoney(d.cost)} _(${tag})_${ling}`);
  });
  const fills = drafts.flatMap((d) => d.info);
  if (fills.length) lines.push('', 'ℹ️ ' + fills.join('\nℹ️ '));
  const warns = drafts.flatMap((d) => d.warnings);
  if (warns.length) lines.push('', '⚠️ ' + warns.join('\n⚠️ '));

  const stillMissing = drafts.some((d) => missingRequired(d).length);
  if (stillMissing) {
    lines.push('', '🚫 Some expenses still show *???* — reply with the missing *wedding date* / *PIC* before I can save.');
  } else {
    lines.push('', 'Reply *ok* to save all, *cancel* to discard.', 'To fix one, reply like *1. 130000* or *3. christi*.');
  }
  return lines.join('\n');
}

function renderOne(draft: ExpenseDraft): string {
  if (draft.isReimbursement) {
    const lines = [
      '💸 *Please confirm this REIMBURSEMENT:*',
      '',
      `*Reimbursed to:* ${draft.description ?? '???'}`,
      `*Amount:* ${formatMoney(draft.reimbursed)} ${config.currency} _(→ REIMBURSED)_`,
      `*Invoice date:* ${draft.invoiceDate ?? '—'}`,
      `*PIC:* ${draft.pic ?? 'LING'}`,
      `*Handler:* ${draft.handler ?? '???'}`,
    ];
    if (draft.info.length) lines.push('', 'ℹ️ ' + draft.info.join('\nℹ️ '));
    if (draft.warnings.length) lines.push('', '⚠️ ' + draft.warnings.join('\n⚠️ '));
    lines.push('', 'Reply *ok* to save, *cancel* to discard.');
    return lines.join('\n');
  }

  // Boss-approved fixed layout — the same 6 fields every time (non-wedding shows
  // "—" for the wedding fields). The TYPE lives in the header ("this SHOP expense")
  // so staff can catch a wrong auto-classification before it's saved.
  const lines: string[] = [`🧾 *Please confirm this ${draft.expenseType.toUpperCase()} expense:*`, ''];
  lines.push(`*Vendor / description:* ${draft.vendorDescription ?? '???'}`);
  lines.push(`*Cost:* ${formatMoney(draft.cost)} ${config.currency}`);
  lines.push(`*Invoice date:* ${draft.invoiceDate ?? '—'}`);
  // A wedding always needs a wedding date + PIC; ??? when missing, — when non-wedding.
  lines.push(`*Wedding date:* ${draft.isWedding ? displayWeddingDate(draft) : '—'}`);
  lines.push(`*PIC:* ${draft.isWedding ? displayPic(draft) : '—'}`);
  lines.push(`*Handler:* ${draft.handler ?? '—'}`);
  if (draft.forLingPayment) lines.push('*💰 For Ling to pay:* yes');
  if (draft.info.length) lines.push('', 'ℹ️ ' + draft.info.join('\nℹ️ '));
  if (draft.warnings.length) lines.push('', '⚠️ ' + draft.warnings.join('\n⚠️ '));

  const missing = missingRequired(draft);
  if (missing.length) {
    lines.push(
      '',
      `🚫 *Cannot save yet* — please provide the *${missing.join('* and *')}*.`,
      `Reply with it (e.g. _16/06 christi_) and I'll update, then reply *ok*.`,
    );
  } else {
    lines.push('', `Reply *ok* to save, *cancel* to discard, or resend with a correction.`);
  }
  return lines.join('\n');
}

function looksLikeExpense(text: string): boolean {
  const hasAmount = /\d{1,3}(?:[.,]\d{3})+/.test(text) || /\b\d{4,}\b/.test(text.replace(/[.,\s]/g, ''));
  const hasDate = /\b\d{1,2}\s*[\/\-]\s*\d{1,2}\b/.test(text);
  return hasAmount || hasDate;
}

/** While a draft is pending, decide whether a message is a correction (act on it)
 *  or just chatter (ignore, so we don't re-post the summary on every message). */
function looksLikeCorrection(text: string): boolean {
  if (looksLikeExpense(text)) return true;
  if (/\b(pic|wed|general|shop|reimburse)\b/i.test(text)) return true;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 2) return true; // a bare name / venue / short fix
  return tokens.some((t) => matchPerson(t)); // mentions a known person
}

function hasTrigger(body: string): boolean {
  const kw = config.triggerKeyword.toLowerCase();
  return body.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).includes(kw);
}

function stripKeyword(body: string): string {
  const kw = config.triggerKeyword.toLowerCase();
  return body.split(/\s+/).filter((t) => t.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() !== kw).join(' ').trim();
}

async function handleCommand(msg: WAMessage, body: string): Promise<void> {
  const [cmd, ...rest] = body.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  // /help, /intro, or a bare "/" all re-post the intro + templates (boss's ask).
  if (cmd === 'help' || cmd === 'intro' || cmd === '') await reply(msg, INTRO_MESSAGE);
  else if (cmd === 'total') await reply(msg, await answerQuestion('What is the total spend this month?'));
  else if (cmd === 'ask' || cmd === 'q') await reply(msg, arg ? await answerQuestion(arg) : 'Usage: /ask <your question>');
  else if (cmd === 'summary') await reply(msg, buildPeriodSummary(arg === 'month' ? 30 : 7));
  else if (cmd === 'owed') await reply(msg, renderOwed(arg));
  else if (cmd === 'undo') await handleUndo(msg, msg.author ?? msg.from);
  else if (cmd === 'iam') {
    const person = matchPerson(arg);
    const id = msg.author ?? msg.from;
    if (person) {
      store.setStaffPerson(id, person, 'manual');
      await reply(msg, `👍 Got it — I'll treat bills you post as handled by *${person}* (unless your note says otherwise).`);
    } else {
      await reply(msg, `Sorry, "${arg}" isn't a name I recognise. Try e.g. */iam christi*, */iam ling*, */iam putri*.`);
    }
  }
  else if (cmd === 'pushsummary') {
    const ids = bossIds();
    if (!ids.length) { await reply(msg, 'No boss recipients configured (BOSS_WHATSAPP_ID).'); return; }
    const text = arg === 'today' ? buildDailyDigest() : buildPeriodSummary(arg === 'month' ? 30 : 7);
    const ok = await pushSummaryTo(ids, text);
    await reply(msg, `📤 Summary DM sent to ${ok}/${ids.length} recipient(s).`);
  }
}

async function handleUndo(msg: WAMessage, sender: string): Promise<void> {
  const last = store.getLastExpense(sender);
  if (!last) {
    await reply(msg, "Nothing to undo — you haven't saved any expenses yet.");
    return;
  }
  let note = '';
  if (last.notion_page_id) {
    const ok = await archiveExpense(last.notion_page_id);
    note = ok ? ' (archived in Notion)' : " (couldn't archive the Notion row — please remove it there manually)";
  }
  store.removeExpense(last.id);
  await reply(msg, `↩️ Removed your last entry: *${last.vendor_description ?? '—'}* ${formatMoney(last.cost)} ${config.currency}${note}.`);
}

function renderOwed(handler: string): string {
  const rows = store.owedByHandler({ handler: handler || undefined });
  if (!rows.length) return handler ? `No recorded expenses for "${handler}".` : 'No expenses recorded yet.';
  const lines = [`💸 *Paid by handler* (recorded, not net of reimbursements):`, ''];
  let total = 0;
  for (const r of rows) {
    total += r.total;
    lines.push(`• ${r.handler}: ${formatMoney(r.total)} ${config.currency} (${r.count})`);
  }
  if (rows.length > 1) lines.push('', `*TOTAL: ${formatMoney(total)} ${config.currency}*`);
  return lines.join('\n');
}

async function reply(msg: WAMessage, text: string, mentions?: string[]): Promise<WAMessage | null> {
  if (config.dryRun) {
    logger.info('\n[reply preview]\n' + text);
    return null;
  }
  await humanizeBefore(await msg.getChat().catch(() => null), text);
  return await msg.reply(text, undefined, mentions?.length ? { mentions } : undefined);
}

/** Test-only hooks (not referenced in production paths). */
export const __test = { finalize, commitPendings, sweepPending, sendNudge, currentPending, pendingsForSender, pendingDrafts };
