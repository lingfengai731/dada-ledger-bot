import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../db/store.js';
import { extractReceipts } from '../agents/visionAgent.js';
import { parseEmployeeNotes, parseEmployeeNote } from '../agents/messageParser.js';
import { mergeToDraft, recomputeVendorDescription, matchPerson, type ExpenseDraft } from '../expense.js';
import { writeExpense, archiveExpense } from '../notion/expenses.js';
import { answerQuestion } from '../agents/queryAgent.js';
import { enrichDraft, missingRequired, displayWeddingDate, displayPic } from '../schedule/enrich.js';
import { buildPeriodSummary } from '../agents/report.js';
import { formatMoney } from '../util/money.js';
import { baliParts, baliNowText } from '../util/dates.js';
import type { Receipt, WeddingNote } from '../types.js';

const { Client, LocalAuth } = pkg;
type WAMessage = pkg.Message;
type WAChat = pkg.Chat;

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SUPPORTED_MEDIA = new Set([...SUPPORTED_IMAGE, 'application/pdf']);
const DEBOUNCE_MS = 10 * 1000;
const MERGE_WINDOW_MS = 5 * 60 * 1000;
const CONFIRM_WORDS = new Set(['ok', 'okay', 'okk', 'yes', 'y', 'ya', 'yep', 'yeah', 'confirm', 'confirmed', 'oke', 'betul', 'save', 'sip', 'good']);
const CANCEL_WORDS = new Set(['cancel', 'no', 'nope', 'batal', 'skip']);

interface BufferedImage { ts: number; mimetype: string; data: string; imagePath: string; }
interface Collecting { image?: BufferedImage; noteText?: string; firstMsg: WAMessage; acked: boolean; timer: NodeJS.Timeout | null; }
interface Pending {
  drafts: ExpenseDraft[];
  notes: WeddingNote[];
  receipt: Receipt | null;
  imagePath: string | null;
  ts: number;
  waMessageId: string;
  /** The chat (group) to post the auto-save / reminder back to. */
  chatId: string;
}

// A draft nobody replied "ok" to is auto-saved after this long (boss's rule:
// don't lose expenses just because staff forgot to confirm). The clock runs from
// the last time the draft was shown or corrected.
const AUTO_WRITE_MS = 8 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const collecting = new Map<string, Collecting>();
const pendingDrafts = new Map<string, Pending>();
let waClient: pkg.Client | null = null;
let pendingRestored = false;

/** Save/replace a sender's open draft to the DB so it survives a restart and
 *  the auto-write sweep can find it. Keeps the in-memory map authoritative. */
function persistPending(sender: string, p: Pending): void {
  pendingDrafts.set(sender, p);
  try {
    store.upsertPending({
      sender,
      chatId: p.chatId,
      waMessageId: p.waMessageId,
      payloadJson: JSON.stringify(p),
      updatedAt: p.ts,
    });
  } catch (err) {
    logger.error({ err }, 'failed to persist pending draft');
  }
}

/** Drop a sender's open draft from both memory and the DB. */
function clearPending(sender: string): void {
  pendingDrafts.delete(sender);
  try {
    store.deletePending(sender);
  } catch (err) {
    logger.error({ err }, 'failed to clear pending draft');
  }
}

/** Re-load drafts left open before a restart so "ok" still works. Runs once. */
function restorePending(): void {
  if (pendingRestored) return;
  pendingRestored = true;
  let n = 0;
  for (const row of store.allPending()) {
    try {
      pendingDrafts.set(row.sender, JSON.parse(row.payload_json) as Pending);
      n++;
    } catch {
      store.deletePending(row.sender);
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

/** DM the spend summary to each id. Returns how many sends succeeded. */
async function pushSummaryTo(ids: string[], days: number): Promise<number> {
  const text = buildPeriodSummary(days);
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
  'Easiest if you write the note like this:',
  '_invoice date / wedding date / PIC / amount / who paid / item_',
  '   e.g. _15/6  16/6  christi  1.000.000  putu  bunga mitir_',
  '',
  "For weddings I really do need the *wedding date* and the *PIC* — if you skip them I'll try to find them from the schedule, but if you still see *???*, just tell me and then reply *ok*.",
  '',
  "I'm a bot, so I only jump in when there's a receipt. Chat away, I won't get in the way. Saved one by mistake? Reply */undo*. Tell me who you are once with */iam <name>* (e.g. _/iam christi_) so I credit your bills correctly. Other things: */total*, */ask*, */help*.",
  '',
  '— — — — —',
  '',
  '👋 Halo semua, saya *DADA Ledger Bot*. Saya catat nota yang kalian kirim di sini biar nggak perlu input manual ke Notion.',
  '',
  'Kirim aja foto nota plus catatan singkat — tanggal, jumlah, untuk siapa. Saya baca, tunjukkan hasilnya, lalu simpan setelah Anda balas *ok*. Boleh beberapa nota sekaligus.',
  '',
  'Paling gampang ditulis begini:',
  '_tanggal nota / tanggal wedding / PIC / jumlah / yang bayar / barang_',
  '   contoh: _15/6  16/6  christi  1.000.000  putu  bunga mitir_',
  '',
  'Untuk wedding saya butuh *tanggal wedding* dan *PIC* — kalau lupa saya coba cari dari schedule, tapi kalau masih *???*, kasih tahu saya lalu balas *ok*.',
  '',
  'Saya cuma bot, jadi saya muncul kalau ada nota aja. Santai ngobrol, nggak bakal saya ganggu. Salah simpan? Balas */undo*. Kasih tahu sekali siapa Anda dengan */iam <nama>* (mis. _/iam christi_) biar nota Anda dicatat benar. Lainnya: */total*, */ask*, */help*.',
].join('\n');

export function createBot() {
  fs.mkdirSync(config.paths.imagesDir, { recursive: true });
  restorePending();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.paths.waAuthDir }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });
  waClient = client;

  client.on('qr', (qr) => {
    logger.info('Scan this QR with WhatsApp → Linked devices → Link a device:');
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
  let lastHealthy = true;
  const heartbeat = setInterval(async () => {
    let state = 'UNKNOWN';
    try {
      state = (await client.getState()) ?? 'UNKNOWN';
    } catch {
      state = 'UNREACHABLE';
    }
    const healthy = state === 'CONNECTED';
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
      logger.error({ state }, '🚨 WhatsApp not connected');
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
    const due = config.summary.cadence === 'monthly' ? dayOfMonth === 1 : weekday === 1;
    if (!due || lastSummaryDate === date) return;
    lastSummaryDate = date;
    await pushSummaryTo(ids, config.summary.cadence === 'monthly' ? 30 : 7);
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
  const chat: WAChat = await msg.getChat();
  if (!chat.isGroup) return false;
  if (config.whatsapp.groupId) return chat.id._serialized === config.whatsapp.groupId;
  return chat.name === config.whatsapp.groupName;
}

async function handleMessage(msg: WAMessage): Promise<void> {
  if (msg.fromMe) return;
  if (!(await isTargetGroup(msg))) return;
  const sender = msg.author ?? msg.from;

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

  const word = body.toLowerCase().replace(/[^a-z]/g, '');
  if (pendingDrafts.has(sender)) {
    if (CONFIRM_WORDS.has(word) || body.includes('✅')) {
      await commit(msg, sender);
      return;
    }
    if (CANCEL_WORDS.has(word)) {
      clearPending(sender);
      await reply(msg, '🗑️ Cancelled — nothing was saved.');
      return;
    }
    // Anything else while a draft is pending is a correction (e.g. "christi", "16/06").
    await onNote(msg, sender, stripKeyword(body));
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

async function onImage(msg: WAMessage, sender: string): Promise<void> {
  const media = await msg.downloadMedia();
  if (!media || !SUPPORTED_MEDIA.has(media.mimetype)) return;

  const ext = media.mimetype === 'application/pdf' ? 'pdf' : (media.mimetype.split('/')[1] ?? 'jpg');
  const imagePath = path.join(config.paths.imagesDir, `${msg.id._serialized.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`);
  fs.writeFileSync(imagePath, Buffer.from(media.data, 'base64'));
  const img: BufferedImage = { ts: Date.now(), mimetype: media.mimetype, data: media.data, imagePath };

  const pending = recentPending(sender);
  if (pending && pending.drafts.length === 1) {
    await reply(msg, '🔎 Reading the receipt…');
    const receipt = await readReceipt(img);
    await finalize(msg, sender, pending.notes, receipt, imagePath, ['Updated with the photo.']);
    return;
  }

  const c = getCollecting(sender, msg);
  c.image = img;
  await ack(msg, c);
  schedule(sender);
}

async function onNote(msg: WAMessage, sender: string, text: string): Promise<void> {
  if (!text) return;
  const pending = recentPending(sender);
  if (pending && pending.drafts.length === 1) {
    const follow = await parseEmployeeNote(text);
    const looksComplete = follow.amount != null && Boolean(follow.description);
    if (looksComplete) {
      // A full new expense (has its own amount + description) — rebuild from it.
      await finalize(msg, sender, [follow], pending.receipt, pending.imagePath, ['Updated with your note.']);
    } else {
      // A partial follow-up = a correction (e.g. "0616 christi"). Merge it in.
      applyCorrection(pending.drafts[0], follow);
      enrichDraft(pending.drafts[0]);
      pending.ts = Date.now();
      persistPending(sender, pending);
      await reply(msg, renderSummary(pending.drafts));
    }
    return;
  }
  const c = getCollecting(sender, msg);
  c.noteText = c.noteText ? `${c.noteText} ${text}` : text;
  schedule(sender);
}

/** Overlay corrective fields from a follow-up note onto an existing draft. */
function applyCorrection(draft: ExpenseDraft, c: WeddingNote): void {
  if (c.weddingDate) draft.weddingDate = c.weddingDate;
  if (c.invoiceDate) draft.invoiceDate = c.invoiceDate;
  if (c.pic) draft.pic = c.pic;
  if (c.location) draft.location = c.location;
  if (c.buyer) draft.handler = c.buyer;
  if (c.description) {
    draft.description = c.description;
    recomputeVendorDescription(draft);
  }
  if (c.amount != null) draft.cost = c.amount;
  if (c.weddingDate || c.pic || c.category === 'wedding' || c.isWedding) draft.isWedding = true;
}

function recentPending(sender: string): Pending | null {
  const p = pendingDrafts.get(sender);
  if (!p) return null;
  if (Date.now() - p.ts > MERGE_WINDOW_MS) {
    pendingDrafts.delete(sender);
    return null;
  }
  return p;
}

function getCollecting(sender: string, msg: WAMessage): Collecting {
  let c = collecting.get(sender);
  if (!c) {
    c = { firstMsg: msg, acked: false, timer: null };
    collecting.set(sender, c);
  }
  return c;
}

async function ack(msg: WAMessage, c: Collecting): Promise<void> {
  if (c.acked) return;
  c.acked = true;
  await reply(msg, '🔎 Reading your expense… one moment.');
}

function schedule(sender: string): void {
  const c = collecting.get(sender);
  if (!c) return;
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    collecting.delete(sender);
    buildFromCollection(c.firstMsg, sender, c.noteText ?? '', c.image ?? null).catch((err) =>
      logger.error({ err }, 'build failed'),
    );
  }, DEBOUNCE_MS);
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

async function buildFromCollection(
  msg: WAMessage,
  sender: string,
  noteText: string,
  img: BufferedImage | null,
): Promise<void> {
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
  // Whoever posts the bill is usually the handler — resolve to a known person
  // (via the learned staff map, growing as colleagues post).
  const senderName = await resolveSenderPerson(msg);
  const chatId = msg.from; // the group jid (where to post the auto-save later)
  // The photo (if any) only enriches the first expense in a multi-expense message.
  const drafts = notes.map((n, i) => {
    const d = mergeToDraft(n, i === 0 ? receipt : null, i === 0 ? imagePath : null, senderName);
    if (i === 0) d.warnings.push(...extraWarnings);
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
  persistPending(sender, { drafts, notes, receipt, imagePath, ts: Date.now(), waMessageId: msg.id._serialized, chatId });
  await reply(msg, renderSummary(drafts));
}

async function commit(msg: WAMessage, sender: string): Promise<void> {
  const pending = pendingDrafts.get(sender);
  if (!pending) return;

  // Boss's rule: a wedding expense must have BOTH a wedding date and a PIC
  // (person in charge). If anything is still ???, refuse to save and ask for it.
  const blocked = pending.drafts
    .map((d, i) => ({ i, missing: missingRequired(d) }))
    .filter((x) => x.missing.length);
  if (blocked.length) {
    pending.ts = Date.now(); // keep the draft alive so they can correct it
    persistPending(sender, pending);
    const lines = ['🚫 *Not saved yet — missing required info:*', ''];
    for (const b of blocked) {
      const label = pending.drafts.length > 1 ? `*${b.i + 1}.* ` : '';
      lines.push(`${label}Please provide the *${b.missing.join('* and *')}*.`);
    }
    lines.push('', 'Just reply with the missing detail (e.g. _16/06 christi_) and I\'ll update it, then reply *ok*.');
    await reply(msg, lines.join('\n'));
    return;
  }

  clearPending(sender);
  const { savedToNotion, total, count } = await savePending(pending, sender);

  if (savedToNotion > 0) {
    await reply(msg, `✅ Saved ${savedToNotion} expense${savedToNotion > 1 ? 's' : ''} to Notion. Total ${formatMoney(total)} ${config.currency}.`);
  } else {
    await reply(msg, `✅ Recorded ${count} expense${count > 1 ? 's' : ''} (${formatMoney(total)} ${config.currency}).\n_Notion preview mode — not written yet._`);
  }
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
      pic: draft.pic,
      handler: draft.handler,
      isWedding: draft.isWedding,
      imagePath: draft.imagePath,
      rawNote: draft.rawNote,
      notionPageId: result.pageId,
    });
    total += draft.cost ?? 0;
  }
  return { savedToNotion, total, count: pending.drafts.length };
}

/**
 * Periodically save drafts nobody confirmed. A draft that still has everything it
 * needs (no ???) is written after AUTO_WRITE_MS and announced in the group. A draft
 * still missing required fields can't be saved — we nudge once and leave it.
 */
async function sweepPending(): Promise<void> {
  const cutoff = Date.now() - AUTO_WRITE_MS;
  for (const row of store.pendingOlderThan(cutoff)) {
    let pending: Pending;
    try {
      pending = JSON.parse(row.payload_json) as Pending;
    } catch {
      store.deletePending(row.sender);
      continue;
    }

    const stillMissing = pending.drafts.some((d) => missingRequired(d).length);
    if (stillMissing) {
      if (!row.reminded) {
        const text =
          '⏰ Reminder: a receipt is still waiting on its *wedding date* / *PIC* before I can save it. ' +
          'Please reply with the missing detail, then *ok*.';
        try {
          if (!config.dryRun) await waClient?.sendMessage(row.chat_id, text);
          else logger.info('\n[auto-reminder preview]\n' + text);
        } catch (err) {
          logger.error({ err }, 'auto-reminder send failed');
        }
        store.markPendingReminded(row.sender);
      }
      continue;
    }

    clearPending(row.sender);
    const { savedToNotion, total, count } = await savePending(pending, row.sender);
    const items = pending.drafts
      .map((d) => `• ${d.vendorDescription ?? '???'} — ${formatMoney(d.cost)}`)
      .join('\n');
    const where = savedToNotion > 0 ? 'to Notion' : '(preview mode — not written to Notion)';
    const text =
      `⏱️ Auto-saved ${count} expense${count > 1 ? 's' : ''} ${where} after 8h with no *ok* reply:\n` +
      `${items}\n*Total ${formatMoney(total)} ${config.currency}.*\nReply */undo* if any of these is wrong.`;
    try {
      if (!config.dryRun) await waClient?.sendMessage(row.chat_id, text);
      else logger.info('\n[auto-save preview]\n' + text);
    } catch (err) {
      logger.error({ err }, 'auto-save announce failed');
    }
    logger.info({ sender: row.sender, count, savedToNotion }, 'auto-saved pending drafts after grace period');
  }
}

function renderSummary(drafts: ExpenseDraft[]): string {
  if (drafts.length === 1) return renderOne(drafts[0]);

  const lines: string[] = [`🧾 *Please confirm these ${drafts.length} expenses:*`, ''];
  let total = 0;
  drafts.forEach((d, i) => {
    total += d.cost ?? 0;
    const inv = d.invoiceDate ? `inv ${d.invoiceDate}` : 'inv —';
    const tag = d.isWedding ? `${inv} · wed ${displayWeddingDate(d)} · ${displayPic(d)}` : `${inv} · non-wedding`;
    lines.push(`*${i + 1}.* ${d.vendorDescription ?? '???'} — ${formatMoney(d.cost)} _(${tag})_`);
  });
  lines.push('', `*TOTAL: ${formatMoney(total)} ${config.currency}*`);
  const fills = drafts.flatMap((d) => d.info);
  if (fills.length) lines.push('', 'ℹ️ ' + fills.join('\nℹ️ '));
  const warns = drafts.flatMap((d) => d.warnings);
  if (warns.length) lines.push('', '⚠️ ' + warns.join('\n⚠️ '));

  const stillMissing = drafts.some((d) => missingRequired(d).length);
  if (stillMissing) {
    lines.push('', '🚫 Some expenses still show *???* — reply with the missing *wedding date* / *PIC* before I can save.');
  } else {
    lines.push('', 'Reply *ok* to save all, *cancel* to discard.');
  }
  return lines.join('\n');
}

function renderOne(draft: ExpenseDraft): string {
  const lines: string[] = ['🧾 *Please confirm this expense:*', ''];
  lines.push(`*Vendor / description:* ${draft.vendorDescription ?? '???'}`);
  lines.push(`*Cost:* ${formatMoney(draft.cost)} ${config.currency}`);
  // Invoice date (when the receipt was issued) is always shown.
  lines.push(`*Invoice date:* ${draft.invoiceDate ?? '—'}`);
  if (draft.isWedding) {
    // Boss's rule: a wedding always needs a wedding date + PIC; ??? when missing.
    lines.push(`*Wedding date:* ${displayWeddingDate(draft)}`);
    lines.push(`*PIC:* ${displayPic(draft)}`);
  } else {
    lines.push('*Type:* non-wedding');
  }
  if (draft.handler) lines.push(`*Handler:* ${draft.handler}`);
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
  if (cmd === 'help') await reply(msg, INTRO_MESSAGE);
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
    const ok = await pushSummaryTo(ids, arg === 'month' ? 30 : 7);
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

async function reply(msg: WAMessage, text: string): Promise<void> {
  if (config.dryRun) logger.info('\n[reply preview]\n' + text);
  else await msg.reply(text);
}
