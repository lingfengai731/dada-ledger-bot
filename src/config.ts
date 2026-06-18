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
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  },
  whatsapp: {
    groupName: process.env.WHATSAPP_GROUP_NAME ?? '',
    groupId: process.env.WHATSAPP_GROUP_ID ?? '',
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY ?? '',
    /** The "EXPENSES" data source id to write rows into (2025-09-03 API). */
    dataSourceId: process.env.NOTION_DATA_SOURCE_ID ?? '',
    /** The "WEDDING SCHEDULE" data source id to READ (enrich missing date/PIC/venue). Empty = CSV only. */
    weddingDataSourceId: process.env.NOTION_WEDDING_DATA_SOURCE_ID ?? '',
    /** 'preview' = log the row but DON'T write; 'live' = actually create the Notion row. */
    writeMode: (process.env.NOTION_WRITE ?? 'preview') as 'preview' | 'live',
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
  dryRun: bool(process.env.DRY_RUN, true),
  currency: process.env.CURRENCY ?? 'IDR',
  locale: process.env.LOCALE ?? 'id-ID',
  paths: {
    dataDir: DATA_DIR,
    dbFile: path.join(DATA_DIR, 'ledger.db'),
    imagesDir: path.join(DATA_DIR, 'images'),
    waAuthDir: path.resolve('./.wwebjs_auth'),
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
