import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../db/store.js';
import { extractReceipts } from '../agents/visionAgent.js';
import { bookkeep } from '../agents/bookkeeperAgent.js';
import { buildReceiptReport } from '../agents/reporterAgent.js';
import { answerQuestion } from '../agents/queryAgent.js';

const { Client, LocalAuth } = pkg;
type WAMessage = pkg.Message;
type WAChat = pkg.Chat;

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Posted automatically when the bot is added to a new group (English + Indonesian). */
const INTRO_MESSAGE = [
  "👋 Hi everyone, I'm *DADA Ledger Bot* — your automated bookkeeping assistant.",
  '',
  "📸 *Just post a receipt photo here* and I'll read it, add up the total, and reply with a tidy summary — handwritten receipts included. One photo can hold several receipts; I'll catch them all.",
  '',
  '🧾 You can also ask me:',
  '• */total* — total spend this month',
  '• */ask <question>* — e.g. _/ask how much did we spend on Fuad this month?_',
  '• */help* — show this guide',
  '',
  '— — — — —',
  '',
  '👋 Halo semuanya, saya *DADA Ledger Bot* — asisten pembukuan otomatis.',
  '',
  '📸 *Cukup kirim foto nota di sini*, saya akan membacanya, menjumlahkan totalnya, dan membalas ringkasannya secara otomatis — termasuk nota tulisan tangan. Satu foto bisa berisi beberapa nota; semuanya akan saya catat.',
  '',
  '🧾 Anda juga bisa bertanya:',
  '• */total* — total pengeluaran bulan ini',
  '• */ask <pertanyaan>* — mis. _/ask berapa pengeluaran untuk Fuad bulan ini?_',
  '• */help* — tampilkan panduan ini',
  '',
  "Selamat datang — kirim saja notanya, sisanya saya yang urus. 🌿",
].join('\n');

export function createBot() {
  fs.mkdirSync(config.paths.imagesDir, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.paths.waAuthDir }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
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
      const chats = await client.getChats();
      const groups = chats.filter((c) => c.isGroup);
      logger.info('--- Your groups (copy the id into WHATSAPP_GROUP_ID if needed) ---');
      for (const g of groups) {
        logger.info(`  ${g.name}  ->  ${g.id._serialized}`);
      }
      logger.info('-----------------------------------------------------------------');
      logger.info(
        { dryRun: config.dryRun, target: config.whatsapp.groupId || config.whatsapp.groupName },
        config.dryRun
          ? 'DRY_RUN on — will read & log but NOT post to the group.'
          : 'Live mode — will post reports to the group.',
      );
    } catch (err) {
      logger.error({ err }, 'failed to list chats');
    }
  });

  // Use `message_create` (not `message`) so it also fires for messages YOU send
  // from the linked account — essential when testing in a group of just yourself.
  // The bot's own report replies are plain text (not images, not "/" commands),
  // so they are ignored by handleMessage and can't cause a loop.
  client.on('message_create', async (msg) => {
    try {
      await handleMessage(client, msg);
    } catch (err) {
      logger.error({ err }, 'error handling message');
    }
  });

  // When the bot itself is added to a NEW group, introduce itself + post the
  // usage guide. Fires for any group (independent of WHATSAPP_GROUP_ID), so the
  // intro appears the moment you add it to the real work group.
  client.on('group_join', async (notification) => {
    try {
      const me = client.info?.wid?._serialized;
      const added: string[] = (notification as any).recipientIds ?? [];
      if (!me || !added.includes(me)) return; // someone else joined, not the bot
      const chat = await notification.getChat();
      logger.info({ group: chat.name }, 'bot added to a new group — introducing itself');
      if (config.dryRun) {
        logger.info('\n[intro preview]\n' + INTRO_MESSAGE);
      } else {
        await chat.sendMessage(INTRO_MESSAGE);
      }
    } catch (err) {
      logger.error({ err }, 'failed to post intro on group join');
    }
  });

  return client;
}

async function isTargetGroup(msg: WAMessage): Promise<boolean> {
  const chat: WAChat = await msg.getChat();
  if (!chat.isGroup) return false;
  if (config.whatsapp.groupId) {
    return chat.id._serialized === config.whatsapp.groupId;
  }
  return chat.name === config.whatsapp.groupName;
}

async function handleMessage(client: pkg.Client, msg: WAMessage): Promise<void> {
  if (!(await isTargetGroup(msg))) return;

  // 1) Image receipts
  if (msg.hasMedia && msg.type === 'image') {
    await handleReceiptImage(msg);
    return;
  }

  // 2) Commands / questions (anything starting with "/")
  const body = (msg.body ?? '').trim();
  if (body.startsWith('/')) {
    await handleCommand(msg, body);
  }
}

async function handleReceiptImage(msg: WAMessage): Promise<void> {
  if (store.hasMessage(msg.id._serialized)) {
    logger.debug({ id: msg.id._serialized }, 'already processed; skipping');
    return;
  }

  const media = await msg.downloadMedia();
  if (!media || !SUPPORTED_IMAGE.has(media.mimetype)) {
    logger.warn({ mimetype: media?.mimetype }, 'unsupported media type');
    return;
  }

  // Persist the image for the record.
  const ext = media.mimetype.split('/')[1] ?? 'jpg';
  const imagePath = path.join(
    config.paths.imagesDir,
    `${msg.id._serialized.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`,
  );
  fs.writeFileSync(imagePath, Buffer.from(media.data, 'base64'));

  logger.info({ imagePath }, 'reading receipt image…');
  const receipts = await extractReceipts(
    media.data,
    media.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
  );

  if (receipts.length === 0) {
    store.markMessageProcessed(msg.id._serialized);
    if (!config.dryRun) await msg.reply(buildReceiptReport([]));
    return;
  }

  const contact = await msg.getContact();
  const stored = await bookkeep({
    waMessageId: msg.id._serialized,
    sender: contact.pushname || contact.number || 'unknown',
    imagePath,
    receipts,
  });

  const report = buildReceiptReport(stored);
  if (config.dryRun) {
    logger.info('\n' + report);
  } else {
    await msg.reply(report);
  }
}

async function handleCommand(msg: WAMessage, body: string): Promise<void> {
  const [cmd, ...rest] = body.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  if (cmd === 'help') {
    await maybeReply(msg, INTRO_MESSAGE);
    return;
  }

  if (cmd === 'total') {
    const answer = await answerQuestion('What is the total spend this month?');
    await maybeReply(msg, answer);
    return;
  }

  if (cmd === 'ask' || cmd === 'q') {
    if (!arg) {
      await maybeReply(msg, 'Usage: /ask <your question>');
      return;
    }
    const answer = await answerQuestion(arg);
    await maybeReply(msg, answer);
    return;
  }
}

async function maybeReply(msg: WAMessage, text: string): Promise<void> {
  if (config.dryRun) {
    logger.info('\n[reply preview]\n' + text);
  } else {
    await msg.reply(text);
  }
}
