import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../db/store.js';
import { extractReceipts } from '../agents/visionAgent.js';
import { parseEmployeeNote } from '../agents/messageParser.js';
import { mergeToDraft, type ExpenseDraft } from '../expense.js';
import { writeExpense } from '../notion/expenses.js';
import { answerQuestion } from '../agents/queryAgent.js';
import { formatMoney } from '../util/money.js';
import type { Receipt, WeddingNote } from '../types.js';

const { Client, LocalAuth } = pkg;
type WAMessage = pkg.Message;
type WAChat = pkg.Chat;

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DEBOUNCE_MS = 10 * 1000; // wait briefly to pair a photo with its note (either order)
const CONFIRM_WORDS = new Set(['ok', 'okay', 'okk', 'yes', 'y', 'ya', 'yep', 'yeah', 'confirm', 'confirmed', 'oke', 'betul', 'save', 'sip', 'good']);
const CANCEL_WORDS = new Set(['cancel', 'no', 'nope', 'batal', 'skip']);

interface BufferedImage {
  ts: number;
  mimetype: string;
  data: string;
  imagePath: string;
}
interface Collecting {
  image?: BufferedImage;
  noteText?: string;
  firstMsg: WAMessage;
  acked: boolean;
  timer: NodeJS.Timeout | null;
}

interface Pending {
  draft: ExpenseDraft;
  note: WeddingNote | null;
  receipt: Receipt | null;
  imagePath: string | null;
  ts: number;
  waMessageId: string;
}

// Keyed by sender id within the target group.
const collecting = new Map<string, Collecting>();
const pendingDrafts = new Map<string, Pending>();
const MERGE_WINDOW_MS = 5 * 60 * 1000; // a later photo/note merges into a draft this fresh

const INTRO_MESSAGE = [
  "👋 Hi everyone, I'm *DADA Ledger Bot* — your automated bookkeeping assistant.",
  '',
  "📸 Just post the *receipt photo* with a short note (date, amount, who it's for) — the way you already do. I'll read both, show you a quick summary, and save it to the ledger once you reply *ok*.",
  '   e.g. _Fuad 11/6 christi wed pandawa 80.000 by Jay_',
  '',
  '🧾 You can also ask me: */total*, */ask <question>*, */help*.',
  '',
  '— — — — —',
  '',
  '👋 Halo semuanya, saya *DADA Ledger Bot* — asisten pembukuan otomatis.',
  '',
  '📸 Cukup kirim *foto nota* dengan catatan singkat (tanggal, jumlah, untuk siapa) seperti biasa. Saya akan membacanya, menampilkan ringkasan, dan menyimpannya setelah Anda balas *ok*.',
  '',
  '🧾 Anda juga bisa: */total*, */ask <pertanyaan>*, */help*.',
].join('\n');

export function createBot() {
  fs.mkdirSync(config.paths.imagesDir, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.paths.waAuthDir }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', (qr) => {
    logger.info('Scan this QR with WhatsApp → Linked devices → Link a device:');
    qrcode.generate(qr, { small: true });
  });
  client.on('auth_failure', (m) => logger.error({ m }, 'WhatsApp auth failure'));
  client.on('disconnected', (r) => logger.warn({ r }, 'WhatsApp disconnected'));

  client.on('ready', async () => {
    logger.info('WhatsApp client ready ✅');
    try {
      const groups = (await client.getChats()).filter((c) => c.isGroup);
      logger.info('--- Groups the bot is in (copy id into WHATSAPP_GROUP_ID) ---');
      for (const g of groups) logger.info(`  ${g.name}  ->  ${g.id._serialized}`);
      logger.info('-------------------------------------------------------------');
      logger.info(
        {
          dryRun: config.dryRun,
          notion: config.notion.writeMode,
          trigger: config.triggerMode,
          target: config.whatsapp.groupId || config.whatsapp.groupName,
        },
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
  if (msg.fromMe) return; // never react to the bot's own messages
  if (!(await isTargetGroup(msg))) return;

  const sender = msg.author ?? msg.from;

  // 1) Receipt image → always a submission in this expense group
  if (msg.hasMedia && msg.type === 'image') {
    await onImage(msg, sender);
    return;
  }

  const body = (msg.body ?? '').trim();
  if (!body) return;

  // 2) Slash commands
  if (body.startsWith('/')) {
    await handleCommand(msg, body);
    return;
  }

  const word = body.toLowerCase().replace(/[^a-z]/g, '');

  // 3) Confirm / cancel — only when this sender has a draft waiting
  if (pendingDrafts.has(sender)) {
    if (CONFIRM_WORDS.has(word) || body.includes('✅')) {
      await commit(msg, sender);
      return;
    }
    if (CANCEL_WORDS.has(word)) {
      pendingDrafts.delete(sender);
      await reply(msg, '🗑️ Cancelled — nothing was saved.');
      return;
    }
  }

  // 4) Is this text an expense note?
  const alreadyCollecting = collecting.has(sender);
  const isNote =
    config.triggerMode === 'keyword'
      ? hasTrigger(body)
      : alreadyCollecting || looksLikeExpense(body) || hasTrigger(body);

  // Don't treat a stray confirm/cancel word as a note.
  if (isNote && !CONFIRM_WORDS.has(word) && !CANCEL_WORDS.has(word)) {
    await onNote(msg, sender, stripKeyword(body));
  }
  // else: normal chatter → ignore
}

async function onImage(msg: WAMessage, sender: string): Promise<void> {
  const media = await msg.downloadMedia();
  if (!media || !SUPPORTED_IMAGE.has(media.mimetype)) return;

  const ext = media.mimetype.split('/')[1] ?? 'jpg';
  const imagePath = path.join(
    config.paths.imagesDir,
    `${msg.id._serialized.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`,
  );
  fs.writeFileSync(imagePath, Buffer.from(media.data, 'base64'));

  const img: BufferedImage = { ts: Date.now(), mimetype: media.mimetype, data: media.data, imagePath };

  // If a fresh draft is already waiting, merge this photo into it.
  const pending = recentPending(sender);
  if (pending) {
    await reply(msg, '🔎 Reading the receipt photo…');
    const receipts = await extractReceipts(
      img.data,
      img.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
    );
    const extra = receipts.length > 1 ? [`${receipts.length} receipts in the photo — using the first.`] : [];
    await finalize(msg, sender, pending.note ?? { ...EMPTY_NOTE }, receipts[0] ?? pending.receipt, imagePath, [...extra, 'Updated with the photo.']);
    return;
  }

  const c = getCollecting(sender, msg);
  c.image = img;
  await ack(msg, c);
  schedule(sender);
}

async function onNote(msg: WAMessage, sender: string, text: string): Promise<void> {
  if (!text) return;

  // If a fresh draft is already waiting, merge this note into it.
  const pending = recentPending(sender);
  if (pending) {
    const note = await parseEmployeeNote(text);
    await finalize(msg, sender, note, pending.receipt, pending.imagePath, ['Updated with your note.']);
    return;
  }

  const c = getCollecting(sender, msg);
  c.noteText = c.noteText ? `${c.noteText} ${text}` : text;
  schedule(sender);
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
    buildDraft(c.firstMsg, sender, c.noteText ?? '', c.image ?? null).catch((err) =>
      logger.error({ err }, 'buildDraft failed'),
    );
  }, DEBOUNCE_MS);
}

const EMPTY_NOTE: WeddingNote = {
  category: 'general', isWedding: false, invoiceDate: null, weddingDate: null, pic: null,
  organiser: null, location: null, buyer: null, description: null, amount: null,
  rawText: '', confidence: 0, notes: null,
};

async function buildDraft(
  msg: WAMessage,
  sender: string,
  noteText: string,
  img: BufferedImage | null,
): Promise<void> {
  const note = noteText.trim() ? await parseEmployeeNote(noteText) : { ...EMPTY_NOTE };

  let receipt = null;
  const extra: string[] = [];
  if (img) {
    const receipts = await extractReceipts(
      img.data,
      img.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
    );
    if (receipts.length > 1) extra.push(`${receipts.length} receipts in the photo — using the first; send the rest separately.`);
    receipt = receipts[0] ?? null;
    if (!receipt) extra.push('Could not read the receipt image clearly.');
  } else {
    extra.push('No photo attached — recorded from your note only.');
  }

  await finalize(msg, sender, note, receipt, img?.imagePath ?? null, extra);
}

async function finalize(
  msg: WAMessage,
  sender: string,
  note: WeddingNote,
  receipt: Receipt | null,
  imagePath: string | null,
  extraWarnings: string[],
): Promise<void> {
  const draft = mergeToDraft(note, receipt, imagePath);
  draft.warnings.push(...extraWarnings);
  pendingDrafts.set(sender, {
    draft,
    note,
    receipt,
    imagePath,
    ts: Date.now(),
    waMessageId: msg.id._serialized,
  });
  await reply(msg, renderSummary(draft));
}

async function commit(msg: WAMessage, sender: string): Promise<void> {
  const pending = pendingDrafts.get(sender);
  if (!pending) return;
  const { draft } = pending;

  const result = await writeExpense(draft);
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
  pendingDrafts.delete(sender);

  if (result.written) {
    await reply(msg, `✅ Saved to Notion. ${draft.vendorDescription ?? ''} — ${formatMoney(draft.cost)} ${config.currency}.`);
  } else {
    await reply(
      msg,
      `✅ Recorded (${formatMoney(draft.cost)} ${config.currency}).\n_Notion preview mode — not written yet._`,
    );
  }
}

function renderSummary(draft: ExpenseDraft): string {
  const lines: string[] = ['🧾 *Please confirm this expense:*', ''];
  lines.push(`*Vendor / description:* ${draft.vendorDescription ?? '—'}`);
  lines.push(`*Cost:* ${formatMoney(draft.cost)} ${config.currency}`);
  if (draft.isWedding) {
    lines.push(`*Wedding date:* ${draft.weddingDate ?? '❓ missing'}`);
    lines.push(`*PIC:* ${draft.pic ?? '❓ missing'}`);
  } else {
    lines.push('*Type:* non-wedding');
  }
  if (draft.invoiceDate) lines.push(`*Invoice date:* ${draft.invoiceDate}`);
  if (draft.handler) lines.push(`*Handler (buyer):* ${draft.handler}`);
  if (draft.warnings.length) lines.push('', '⚠️ ' + draft.warnings.join('\n⚠️ '));
  lines.push('', `Reply *ok* to save, *cancel* to discard, or just resend with the correction.`);
  return lines.join('\n');
}

function looksLikeExpense(text: string): boolean {
  const hasAmount =
    /\d{1,3}(?:[.,]\d{3})+/.test(text) || /\b\d{4,}\b/.test(text.replace(/[.,\s]/g, ''));
  const hasDate = /\b\d{1,2}\s*[\/\-]\s*\d{1,2}\b/.test(text);
  return hasAmount || hasDate;
}

function hasTrigger(body: string): boolean {
  const kw = config.triggerKeyword.toLowerCase();
  return body.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).includes(kw);
}

function stripKeyword(body: string): string {
  const kw = config.triggerKeyword.toLowerCase();
  return body
    .split(/\s+/)
    .filter((t) => t.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() !== kw)
    .join(' ')
    .trim();
}

async function handleCommand(msg: WAMessage, body: string): Promise<void> {
  const [cmd, ...rest] = body.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  if (cmd === 'help') {
    await reply(msg, INTRO_MESSAGE);
  } else if (cmd === 'total') {
    await reply(msg, await answerQuestion('What is the total spend this month?'));
  } else if (cmd === 'ask' || cmd === 'q') {
    await reply(msg, arg ? await answerQuestion(arg) : 'Usage: /ask <your question>');
  }
}

async function reply(msg: WAMessage, text: string): Promise<void> {
  if (config.dryRun) logger.info('\n[reply preview]\n' + text);
  else await msg.reply(text);
}
