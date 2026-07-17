import 'dotenv/config';
import path from 'node:path';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');

export const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    /** Model id, or 'auto'/'latest' to auto-pick the newest Opus at startup —
     *  so the bot tracks the strongest model without a code change. */
    model: process.env.ANTHROPIC_MODEL ?? 'auto',
  },
  whatsapp: {
    groupName: process.env.WHATSAPP_GROUP_NAME ?? '',
    groupId: process.env.WHATSAPP_GROUP_ID ?? '',
    /** Bot's own number (e.g. 8613078287710) to link via an 8-char pairing code
     *  instead of scanning a QR — far easier when re-linking over SSH/console. */
    pairNumber: (process.env.WA_PAIR_NUMBER ?? '').replace(/\D/g, ''),
    /** Local/desktop fallback: show a visible Chrome window for WhatsApp Web.
     *  Default stays headless for the VPS. */
    headless: bool(process.env.PUPPETEER_HEADLESS, true),
    /** Optional Chrome/Chromium executable path (useful on Windows local runs). */
    executablePath: process.env.CHROME_EXECUTABLE_PATH ?? '',
  },
  silentIntake: {
    /** Main/real group to listen to silently. Empty = disabled. */
    sourceGroupId: process.env.MAIN_SILENT_GROUP_ID ?? '',
    /** Secondary/test/audit group where the bot posts save status. */
    auditGroupId: process.env.AUDIT_GROUP_ID ?? '',
    /** Must be true before messages from MAIN_SILENT_GROUP_ID are written directly. */
    autoSave: bool(process.env.MAIN_SILENT_AUTOSAVE, false),
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY ?? '',
    /** The "EXPENSES" data source id to write rows into (2025-09-03 API). */
    dataSourceId: process.env.NOTION_DATA_SOURCE_ID ?? '',
    /** The "WEDDING SCHEDULE" data source id to READ (enrich missing date/PIC/venue). Empty = CSV only. */
    weddingDataSourceId: process.env.NOTION_WEDDING_DATA_SOURCE_ID ?? '',
    /** Name of the relation column on EXPENSES that links a row to its wedding on
     *  the WEDDING SCHEDULE (boss added it for per-project rollups). The bot fills
     *  it automatically when it can resolve the wedding's page id (needs the live
     *  Notion schedule read). Set empty to disable. */
    weddingRelationProp: process.env.NOTION_WEDDING_RELATION_PROP ?? 'WEDDING',
    /** 'preview' = log the row but DON'T write; 'live' = actually create the Notion row. */
    writeMode: (process.env.NOTION_WRITE ?? 'preview') as 'preview' | 'live',
    /** Attach the receipt photo/PDF into the created Notion page body (best-effort).
     *  Off-switch in case the file-upload API misbehaves in production. */
    attachReceipts: bool(process.env.NOTION_ATTACH_RECEIPTS, true),
    get hasToken(): boolean {
      return Boolean(process.env.NOTION_API_KEY);
    },
  },
  /**
   * 'auto'    = any receipt photo, or any message with a date/amount, is an expense
   *             submission (best for a dedicated expense group). No keyword needed.
   * 'keyword' = only messages containing TRIGGER_KEYWORD are processed (strict).
   */
  triggerMode: (process.env.TRIGGER_MODE ?? 'auto') as 'auto' | 'keyword',
  /** Optional keyword accelerator; required only in 'keyword' mode. */
  triggerKeyword: process.env.TRIGGER_KEYWORD ?? 'exp',
  /** Optional URL pinged every few minutes while WhatsApp is connected, so an
   * external monitor (e.g. healthchecks.io) can alert if the bot goes silent. */
  healthcheckUrl: process.env.HEALTHCHECK_URL ?? '',
  summary: {
    /** Boss WhatsApp id ("<countrycode><number>@c.us") to DM the periodic summary. Empty = off. */
    bossWhatsappId: process.env.BOSS_WHATSAPP_ID ?? '',
    /** 'daily' (every day), 'weekly' (Mondays) or 'monthly' (1st). */
    cadence: (process.env.SUMMARY_CADENCE ?? 'weekly') as 'daily' | 'weekly' | 'monthly',
    /** Hour (Bali time, 0-23) to send on the due day. */
    hour: Number(process.env.SUMMARY_HOUR ?? '9'),
  },
  dryRun: bool(process.env.DRY_RUN, true),
  /** Humanize outgoing group replies: mark the chat seen, show "typing…", and wait
   *  a short randomized, length-scaled beat before sending — so the bot looks less
   *  like instant-reply automation (a ban signal). Timing/presence ONLY; never
   *  touches parsing, so accuracy is unaffected. Off with HUMANIZE_REPLIES=false. */
  humanizeReplies: bool(process.env.HUMANIZE_REPLIES, true),
  currency: process.env.CURRENCY ?? 'IDR',
  locale: process.env.LOCALE ?? 'id-ID',
  paths: {
    dataDir: DATA_DIR,
    dbFile: path.join(DATA_DIR, 'ledger.db'),
    imagesDir: path.join(DATA_DIR, 'images'),
    waAuthDir: path.resolve(process.env.WA_AUTH_DIR ?? './.wwebjs_auth'),
    /** Local snapshot of the Notion WEDDING SCHEDULE used to fill missing wedding date / PIC / venue. */
    weddingScheduleCsv: path.join(DATA_DIR, 'wedding-schedule.csv'),
  },
} as const;

/** Throw early with a friendly message if required config is missing. */
export function assertConfig(): void {
  const problems: string[] = [];
  if (!config.anthropic.apiKey) {
    problems.push('ANTHROPIC_API_KEY is missing — copy .env.example to .env and fill it in.');
  }
  if (!config.whatsapp.groupName && !config.whatsapp.groupId) {
    problems.push('Set WHATSAPP_GROUP_NAME or WHATSAPP_GROUP_ID in .env.');
  }
  if (problems.length > 0) {
    throw new Error('Configuration problem:\n  - ' + problems.join('\n  - '));
  }
}
