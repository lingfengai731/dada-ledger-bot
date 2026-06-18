import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { proxyFetch } from '../bootstrap.js';
import type { ExpenseDraft } from '../expense.js';

/**
 * Writes confirmed expenses into the existing Notion "EXPENSES" data source
 * (2025-09-03 multi-data-source API). PIC and HANDLER are multi_selects with
 * fixed option lists, so free-text names are mapped to the closest option.
 */

// Valid wedding PICs (boss rule: only these run weddings). Used as the mapping
// target for the PIC column, intersected with whatever options actually exist
// in Notion so we never write a PIC the database doesn't have.
const PIC_VALID = ['LING', 'JAY', 'CHRISTI', 'PUTRI', 'GENERAL'];
// Fallbacks used only until the first live option fetch succeeds.
const PIC_FALLBACK = [...PIC_VALID, 'KENT', 'HIRA', 'RANIA'];
const HANDLER_FALLBACK = [
  'RANIA', 'HIRA', 'JAY', 'PUTRI', 'MINGGU', 'PUTU', 'LING', 'KENT', 'CHRISTI', 'MADE',
  'JESICHA', 'HAMZAH', 'JESSICA',
];
// Name aliases for the PIC column (boss: "jessica" is the same person as JAY).
const PIC_ALIAS: Record<string, string> = { JESSICA: 'JAY', JESICHA: 'JAY' };

const notion = config.notion.hasToken
  ? new Client({
      auth: config.notion.apiKey,
      ...(proxyFetch ? { fetch: proxyFetch as unknown as typeof fetch } : {}),
    })
  : null;

// Live PIC/HANDLER option lists, read from the EXPENSES data source schema so
// the bot stays in sync when the boss renames/adds options (e.g. RANIA→HIRA).
let optCache: { pic: string[]; handler: string[] } | null = null;
let optTs = 0;
const OPT_TTL_MS = 15 * 60 * 1000;

async function getOptions(): Promise<{ pic: string[]; handler: string[] }> {
  if (optCache && Date.now() - optTs < OPT_TTL_MS) return optCache;
  if (!notion || !config.notion.dataSourceId) {
    return optCache ?? { pic: PIC_FALLBACK, handler: HANDLER_FALLBACK };
  }
  try {
    const ds: any = await (notion as any).dataSources.retrieve({ data_source_id: config.notion.dataSourceId });
    const names = (prop: string): string[] =>
      (ds.properties?.[prop]?.multi_select?.options ?? []).map((o: any) => o.name).filter(Boolean);
    const pic = names('PIC');
    const handler = names('HANDLER');
    optCache = { pic: pic.length ? pic : PIC_FALLBACK, handler: handler.length ? handler : HANDLER_FALLBACK };
    optTs = Date.now();
    logger.info({ pic: optCache.pic, handler: optCache.handler }, 'Notion PIC/HANDLER options synced');
    return optCache;
  } catch (err: any) {
    logger.warn({ err: err?.code ?? err?.message ?? err }, 'PIC/HANDLER option sync failed — using last/fallback');
    return optCache ?? { pic: PIC_FALLBACK, handler: HANDLER_FALLBACK };
  }
}

/** Map a free-text name to one of the allowed options (case-insensitive, prefix/contains). */
function mapOption(raw: string | null, options: string[]): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (!up) return null;
  const exact = options.find((o) => o === up);
  if (exact) return exact;
  const partial = options.find((o) => o.startsWith(up) || up.startsWith(o) || o.includes(up));
  return partial ?? null;
}

export interface NotionResult {
  written: boolean;
  pageId: string | null;
  /** The properties we built (shown in preview mode). */
  properties: Record<string, unknown>;
  /** Names that didn't map to a Notion option, for the human to fix. */
  unmapped: string[];
}

function buildProperties(
  draft: ExpenseDraft,
  opts: { pic: string[]; handler: string[] },
): { properties: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
  // PIC target = valid wedding PICs that actually exist in the Notion options.
  const picTargets = PIC_VALID.filter((p) => opts.pic.some((o) => o.toUpperCase() === p));
  const picOptions = picTargets.length ? picTargets : PIC_VALID;
  // The ledger writes vendor/description in UPPERCASE — match that house style.
  const title = (draft.vendorDescription ?? 'UNKNOWN').toUpperCase().slice(0, 1900);
  const properties: Record<string, unknown> = {
    'VENDOR / DESCRIPTION': { title: [{ text: { content: title } }] },
  };

  if (draft.cost != null) {
    properties['COST'] = { number: draft.cost };
    properties['PRICE'] = { number: draft.cost }; // historical rows fill PRICE = COST
  }
  if (draft.invoiceDate) properties['INVOICE DATE'] = { date: { start: draft.invoiceDate } };
  if (draft.isWedding && draft.weddingDate)
    properties['WEDDING DATE'] = { date: { start: draft.weddingDate } };

  const picRaw = draft.pic ? (PIC_ALIAS[draft.pic.trim().toUpperCase()] ?? draft.pic) : null;
  const pic = mapOption(picRaw, picOptions);
  if (pic) properties['PIC'] = { multi_select: [{ name: pic }] };
  else if (draft.pic) unmapped.push(`PIC "${draft.pic}"`);

  const handler = mapOption(draft.handler, opts.handler);
  if (handler) properties['HANDLER'] = { multi_select: [{ name: handler }] };
  else if (draft.handler) unmapped.push(`HANDLER "${draft.handler}"`);

  return { properties, unmapped };
}

/** Create (or preview) a Notion EXPENSES row from a confirmed draft. */
export async function writeExpense(draft: ExpenseDraft): Promise<NotionResult> {
  const opts = await getOptions();
  const { properties, unmapped } = buildProperties(draft, opts);

  const shouldWrite =
    config.notion.writeMode === 'live' && notion && config.notion.dataSourceId;

  if (!shouldWrite) {
    logger.info(
      { mode: config.notion.writeMode, hasToken: config.notion.hasToken, dataSource: Boolean(config.notion.dataSourceId) },
      'Notion write skipped (preview)',
    );
    return { written: false, pageId: null, properties, unmapped };
  }

  try {
    const page: any = await notion!.pages.create({
      parent: { type: 'data_source_id', data_source_id: config.notion.dataSourceId } as any,
      properties: properties as any,
    });
    logger.info({ pageId: page.id }, 'Notion expense row created');
    return { written: true, pageId: page.id, properties, unmapped };
  } catch (err) {
    logger.error({ err }, 'Notion write failed');
    return { written: false, pageId: null, properties, unmapped };
  }
}
