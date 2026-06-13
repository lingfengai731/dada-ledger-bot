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
    databaseId: process.env.NOTION_DATABASE_ID ?? '',
    get enabled(): boolean {
      return Boolean(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID);
    },
  },
  dryRun: bool(process.env.DRY_RUN, true),
  currency: process.env.CURRENCY ?? 'IDR',
  locale: process.env.LOCALE ?? 'id-ID',
  paths: {
    dataDir: DATA_DIR,
    dbFile: path.join(DATA_DIR, 'ledger.db'),
    imagesDir: path.join(DATA_DIR, 'images'),
    waAuthDir: path.resolve('./.wwebjs_auth'),
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
