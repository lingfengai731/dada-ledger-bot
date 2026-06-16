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

// PIC = current wedding leads only (boss: KENT is a former employee, RANIA is an
// assistant who doesn't run weddings — both excluded from PIC).
const PIC_OPTIONS = ['LING', 'JAY', 'CHRISTI', 'PUTRI', 'GENERAL'];
const HANDLER_OPTIONS = [
  'RANIA', 'JAY', 'PUTRI', 'MINGGU', 'PUTU', 'LING', 'KENT', 'CHRISTI', 'MADE',
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

function buildProperties(draft: ExpenseDraft): { properties: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
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
  const pic = mapOption(picRaw, PIC_OPTIONS);
  if (pic) properties['PIC'] = { multi_select: [{ name: pic }] };
  else if (draft.pic) unmapped.push(`PIC "${draft.pic}"`);

  const handler = mapOption(draft.handler, HANDLER_OPTIONS);
  if (handler) properties['HANDLER'] = { multi_select: [{ name: handler }] };
  else if (draft.handler) unmapped.push(`HANDLER "${draft.handler}"`);

  return { properties, unmapped };
}

/** Create (or preview) a Notion EXPENSES row from a confirmed draft. */
export async function writeExpense(draft: ExpenseDraft): Promise<NotionResult> {
  const { properties, unmapped } = buildProperties(draft);

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
