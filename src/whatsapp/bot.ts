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

const { Client, LocalAuth } = pkg;
type WAMessage = pkg.Message;
type WAChat = pkg.Chat;

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const WINDOW_MS = 5 * 60 * 1000; // how long an image/note waits for its pair
const CONFIRM_WORDS = new Set(['ok', 'okay', 'okk', 'yes', 'y', 'ya', 'yep', 'yeah', 'confirm', 'confirmed', 'oke', 'betul', 'save', 'sip']);
const CANCEL_WORDS = new Set(['cancel', 'no', 'nope', 'batal']);

interface BufferedImage {
  msgId: string;
  ts: number;
  mimetype: string;
  data: string; // base64
  imagePath: string;
}

// All keyed by sender id (within the target group).
const recentImages = new Map<string, BufferedImage[]>();
const pendingNotes = new Map<string, { text: string; ts: number }>();
const pendingDrafts = new Map<string, { draft: ExpenseDraft; ts: number; waMessageId: string }>();

/** Posted automatically when the bot is added to a new group (English + Indonesian). */
const INTRO_MESSAGE = [
  "👋 Hi everyone, I'm *DADA Ledger Bot* — your automated bookkeeping assistant.",
  '',
  `📸 To log an expense: post the *receipt photo* and a short note that includes the keyword *"${config.triggerKeyword}"*, e.g.`,
  `   _${config.triggerKeyword} Fuad 11/6 lte wed pandawa 80.000 by Jay_`,
  "I'll read both, show you a summary, and save it once you reply *ok*. (I ignore normal chat.)",
  '',
  '🧾 You can also ask: */total*, */ask <question>*, */help*.',
  '',
  '— — — — —',
  '',
  '👋 Halo semuanya, saya *DADA Ledger Bot* — asisten pembukuan otomatis.',
  '',
  `📸 Untuk mencatat pengeluaran: kirim *foto nota* + catatan singkat berisi kata kunci *"${config.triggerKeyword}"*, mis.`,
  `   _${config.triggerKeyword} Fuad 11/6 lte wed pandawa 80.000 by Jay_`,
  'Saya akan membaca keduanya, menampilkan ringkasan, dan menyimpannya setelah Anda balas *ok*.',
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
          trigger: config.triggerKeyword,
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
  prune();

  // 1) Receipt image
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

  // 3) Expense submission (note containing the trigger keyword)
  if (hasTrigger(body)) {
    await onTriggeredNote(msg, sender, body);
    return;
  }

  // 4) Confirm / cancel — only if this sender has a draft waiting
  if (pendingDrafts.has(sender)) {
    const word = body.toLowerCase().replace(/[^a-z]/g, '');
    if (CONFIRM_WORDS.has(word) || body.includes('✅')) {
      await commit(msg, sender);
    } else if (CANCEL_WORDS.has(word)) {
      pendingDrafts.delete(sender);
      await reply(msg, '🗑️ Cancelled — nothing was saved.');
    }
  }
  // otherwise: normal chat, ignore
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

  const img: BufferedImage = {
    msgId: msg.id._serialized,
    ts: Date.now(),
    mimetype: media.mimetype,
    data: media.data,
    imagePath,
  };
  const list = recentImages.get(sender) ?? [];
  list.push(img);
  recentImages.set(sender, list);

  // If a triggered note from this sender is already waiting, build the draft now.
  const note = pendingNotes.get(sender);
  if (note && Date.now() - note.ts <= WINDOW_MS) {
    pendingNotes.delete(sender);
    await buildDraft(msg, sender, note.text, img);
  }
}

async function onTriggeredNote(msg: WAMessage, sender: string, body: string): Promise<void> {
  const img = takeRecentImage(sender);
  if (img) {
    await buildDraft(msg, sender, body, img);
  } else {
    pendingNotes.set(sender, { text: body, ts: Date.now() });
    await reply(msg, `📝 Got your note. Now send the *receipt photo* (within 5 min) and I'll total it up.`);
  }
}

async function buildDraft(
  msg: WAMessage,
  sender: string,
  noteText: string,
  img: BufferedImage | null,
): Promise<void> {
  const note = await parseEmployeeNote(stripKeyword(noteText));

  let receipt = null;
  const extraWarnings: string[] = [];
  if (img) {
    const receipts = await extractReceipts(
      img.data,
      img.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
    );
    if (receipts.length > 1) extraWarnings.push(`${receipts.length} receipts detected in the photo — using the first; submit the rest separately.`);
    receipt = receipts[0] ?? null;
    if (!receipt) extraWarnings.push('Could not read the receipt image clearly.');
  }

  const draft = mergeToDraft(note, receipt, img?.imagePath ?? null);
  draft.warnings.push(...extraWarnings);
  pendingDrafts.set(sender, { draft, ts: Date.now(), waMessageId: msg.id._serialized });
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
    await reply(msg, `✅ Saved to Notion. Total ${formatMoney(draft.cost)} ${config.currency}.`);
  } else {
    await reply(
      msg,
      `✅ Recorded locally (${formatMoney(draft.cost)} ${config.currency}).\n_Notion preview mode — not written. Set NOTION_WRITE=live + a data source id to push to Notion._`,
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
    lines.push('*Type:* non-wedding expense');
  }
  if (draft.invoiceDate) lines.push(`*Invoice date:* ${draft.invoiceDate}`);
  if (draft.handler) lines.push(`*Handler (buyer):* ${draft.handler}`);

  if (draft.warnings.length) {
    lines.push('', '⚠️ ' + draft.warnings.join('\n⚠️ '));
  }
  lines.push('', `Reply *ok* to save, *cancel* to discard, or resend a corrected _${config.triggerKeyword} ..._ note.`);
  return lines.join('\n');
}

function takeRecentImage(sender: string): BufferedImage | null {
  const list = recentImages.get(sender);
  if (!list || list.length === 0) return null;
  // most recent within window
  for (let i = list.length - 1; i >= 0; i--) {
    if (Date.now() - list[i].ts <= WINDOW_MS) {
      const [img] = list.splice(i, 1);
      recentImages.set(sender, list);
      return img;
    }
  }
  return null;
}

function hasTrigger(body: string): boolean {
  const kw = config.triggerKeyword.toLowerCase();
  return body
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .includes(kw);
}

function stripKeyword(body: string): string {
  const kw = config.triggerKeyword.toLowerCase();
  return body
    .split(/\s+/)
    .filter((t) => t.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() !== kw)
    .join(' ')
    .trim();
}

function prune(): void {
  const now = Date.now();
  for (const [k, list] of recentImages) {
    const kept = list.filter((i) => now - i.ts <= WINDOW_MS);
    if (kept.length) recentImages.set(k, kept);
    else recentImages.delete(k);
  }
  for (const [k, n] of pendingNotes) if (now - n.ts > WINDOW_MS) pendingNotes.delete(k);
  for (const [k, d] of pendingDrafts) if (now - d.ts > 30 * 60 * 1000) pendingDrafts.delete(k);
}

async function handleCommand(msg: WAMessage, body: string): Promise<void> {
  const [cmd, ...rest] = body.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  if (cmd === 'help') {
    await reply(msg, INTRO_MESSAGE);
    return;
  }
  if (cmd === 'total') {
    await reply(msg, await answerQuestion('What is the total spend this month?'));
    return;
  }
  if (cmd === 'ask' || cmd === 'q') {
    if (!arg) {
      await reply(msg, 'Usage: /ask <your question>');
      return;
    }
    await reply(msg, await answerQuestion(arg));
  }
}

async function reply(msg: WAMessage, text: string): Promise<void> {
  if (config.dryRun) logger.info('\n[reply preview]\n' + text);
  else await msg.reply(text);
}
