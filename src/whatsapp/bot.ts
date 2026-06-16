import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../db/store.js';
import { extractReceipts } from '../agents/visionAgent.js';
import { parseEmployeeNotes } from '../agents/messageParser.js';
import { mergeToDraft, type ExpenseDraft } from '../expense.js';
import { writeExpense } from '../notion/expenses.js';
import { answerQuestion } from '../agents/queryAgent.js';
import { formatMoney } from '../util/money.js';
import type { Receipt, WeddingNote } from '../types.js';

const { Client, LocalAuth } = pkg;
type WAMessage = pkg.Message;
type WAChat = pkg.Chat;

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
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
}

const collecting = new Map<string, Collecting>();
const pendingDrafts = new Map<string, Pending>();

const INTRO_MESSAGE = [
  "👋 Hi everyone, I'm *DADA Ledger Bot* — your automated bookkeeping assistant.",
  '',
  "📸 Just post the *receipt photo* with a short note (date, amount, who it's for) — the way you already do. I'll read it, show you a quick summary, and save it to the ledger once you reply *ok*. You can list several expenses in one message too.",
  '   e.g. _06/15 gosend kyea 06/16 115.500 putu (komaneka)_',
  '',
  '🧾 You can also ask me: */total*, */ask <question>*, */help*.',
  '',
  '— — — — —',
  '',
  '👋 Halo semuanya, saya *DADA Ledger Bot* — asisten pembukuan otomatis.',
  '',
  '📸 Cukup kirim *foto nota* dengan catatan singkat (tanggal, jumlah, untuk siapa) seperti biasa. Saya akan membacanya, menampilkan ringkasan, dan menyimpannya setelah Anda balas *ok*. Boleh beberapa pengeluaran dalam satu pesan.',
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

  if (msg.hasMedia && msg.type === 'image') {
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
      pendingDrafts.delete(sender);
      await reply(msg, '🗑️ Cancelled — nothing was saved.');
      return;
    }
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
  if (!media || !SUPPORTED_IMAGE.has(media.mimetype)) return;

  const ext = media.mimetype.split('/')[1] ?? 'jpg';
  const imagePath = path.join(config.paths.imagesDir, `${msg.id._serialized.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`);
  fs.writeFileSync(imagePath, Buffer.from(media.data, 'base64'));
  const img: BufferedImage = { ts: Date.now(), mimetype: media.mimetype, data: media.data, imagePath };

  const pending = recentPending(sender);
  if (pending && pending.drafts.length === 1) {
    await reply(msg, '🔎 Reading the receipt photo…');
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
    const notes = await parseEmployeeNotes(text);
    await finalize(msg, sender, notes, pending.receipt, pending.imagePath, ['Updated with your note.']);
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
  const receipts = await extractReceipts(
    img.data,
    img.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
  );
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

async function finalize(
  msg: WAMessage,
  sender: string,
  notes: WeddingNote[],
  receipt: Receipt | null,
  imagePath: string | null,
  extraWarnings: string[],
): Promise<void> {
  // The photo (if any) only enriches the first expense in a multi-expense message.
  const drafts = notes.map((n, i) => {
    const d = mergeToDraft(n, i === 0 ? receipt : null, i === 0 ? imagePath : null);
    if (i === 0) d.warnings.push(...extraWarnings);
    return d;
  });
  pendingDrafts.set(sender, { drafts, notes, receipt, imagePath, ts: Date.now(), waMessageId: msg.id._serialized });
  await reply(msg, renderSummary(drafts));
}

async function commit(msg: WAMessage, sender: string): Promise<void> {
  const pending = pendingDrafts.get(sender);
  if (!pending) return;
  pendingDrafts.delete(sender);

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

  const n = pending.drafts.length;
  if (savedToNotion > 0) {
    await reply(msg, `✅ Saved ${savedToNotion} expense${savedToNotion > 1 ? 's' : ''} to Notion. Total ${formatMoney(total)} ${config.currency}.`);
  } else {
    await reply(msg, `✅ Recorded ${n} expense${n > 1 ? 's' : ''} (${formatMoney(total)} ${config.currency}).\n_Notion preview mode — not written yet._`);
  }
}

function renderSummary(drafts: ExpenseDraft[]): string {
  if (drafts.length === 1) return renderOne(drafts[0]);

  const lines: string[] = [`🧾 *Please confirm these ${drafts.length} expenses:*`, ''];
  let total = 0;
  drafts.forEach((d, i) => {
    total += d.cost ?? 0;
    const tag = d.isWedding ? `wed ${d.weddingDate ?? '?'}` : 'non-wedding';
    lines.push(`*${i + 1}.* ${d.vendorDescription ?? '—'} — ${formatMoney(d.cost)} _(${tag})_`);
  });
  lines.push('', `*TOTAL: ${formatMoney(total)} ${config.currency}*`);
  const warns = drafts.flatMap((d) => d.warnings);
  if (warns.length) lines.push('', '⚠️ ' + warns.join('\n⚠️ '));
  lines.push('', 'Reply *ok* to save all, *cancel* to discard.');
  return lines.join('\n');
}

function renderOne(draft: ExpenseDraft): string {
  const lines: string[] = ['🧾 *Please confirm this expense:*', ''];
  lines.push(`*Vendor / description:* ${draft.vendorDescription ?? '—'}`);
  lines.push(`*Cost:* ${formatMoney(draft.cost)} ${config.currency}`);
  if (draft.isWedding) {
    lines.push(`*Wedding date:* ${draft.weddingDate ?? '❓ missing'}`);
    lines.push(`*PIC:* ${draft.pic ?? '—'}`);
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
}

async function reply(msg: WAMessage, text: string): Promise<void> {
  if (config.dryRun) logger.info('\n[reply preview]\n' + text);
  else await msg.reply(text);
}
