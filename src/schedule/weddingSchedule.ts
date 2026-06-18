import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseChineseDate, daysBetween } from '../util/dates.js';

/**
 * The WEDDING SCHEDULE — DADA's human-entered master list of weddings
 * (client, contact, venue, PIC, date). It is the ground truth the bot uses to
 * fill in a wedding's DATE / PIC / VENUE when staff omit them on a receipt note.
 *
 * Source: LIVE from the Notion "WEDDING SCHEDULE" data source when
 * NOTION_WEDDING_DATA_SOURCE_ID is set and the page is shared with the
 * integration (refreshed periodically, so weddings the team add show up
 * automatically). Falls back to a CSV snapshot (data/wedding-schedule.csv)
 * until/if the first live refresh succeeds. Lookups are sync against the
 * in-memory cache regardless of source.
 */

export interface ScheduleEntry {
  client: string;
  contact: string;
  venue: string;
  venueKey: string; // normalized for matching
  pics: string[]; // mapped to EXPENSES PIC options (LING/JAY/CHRISTI/PUTRI/GENERAL)
  weddingDate: string; // ISO start date
  weddingEnd: string | null;
  status: string;
}

export interface ScheduleMatch {
  weddingDate: string;
  pic: string | null;
  venue: string;
  client: string;
  /** How we matched: exact date, venue+date, venue, or client. */
  via: 'date' | 'venue+date' | 'venue' | 'client';
  confidence: number;
  /** Other plausible weddings (for the human to disambiguate). */
  alternatives: ScheduleEntry[];
}

// Map the schedule's free-text PIC names onto the EXPENSES PIC options.
const PIC_OPTIONS = ['LING', 'JAY', 'CHRISTI', 'PUTRI', 'GENERAL'];
function mapPic(raw: string): string | null {
  const s = raw.toLowerCase();
  if (s.includes('putri') || s.includes('radityasari')) return 'PUTRI';
  if (s.includes('christ') || s.includes('andrian')) return 'CHRISTI'; // christi/christy/christie
  if (s.includes('jessic') || s.includes('jesic') || s.includes('earvin') || s.includes('jay')) return 'JAY';
  if (s.includes('ling')) return 'LING';
  if (s.includes('dada') || s.includes('dāda') || s.includes('island') || s.includes('general')) return 'GENERAL';
  return null;
}

export function venueKey(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields and embedded newlines/commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // ignore; \n handles the break
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

type Cache = { entries: ScheduleEntry[]; byVenue: Map<string, ScheduleEntry[]>; byDate: Map<string, ScheduleEntry[]> };
let cache: Cache | null = null;
let liveLoaded = false; // true once a live Notion refresh has populated the cache

function buildIndex(entries: ScheduleEntry[]): Cache {
  const byVenue = new Map<string, ScheduleEntry[]>();
  const byDate = new Map<string, ScheduleEntry[]>();
  for (const e of entries) {
    if (e.venueKey) (byVenue.get(e.venueKey) ?? byVenue.set(e.venueKey, []).get(e.venueKey)!).push(e);
    (byDate.get(e.weddingDate) ?? byDate.set(e.weddingDate, []).get(e.weddingDate)!).push(e);
  }
  cache = { entries, byVenue, byDate };
  return cache;
}

function load(): Cache {
  if (cache) return cache;
  return buildIndex(loadFromCsv());
}

function loadFromCsv(): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const file = config.paths.weddingScheduleCsv;
  try {
    if (fs.existsSync(file)) {
      const rows = parseCsv(fs.readFileSync(file, 'utf8'));
      const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
      const col = (name: string) => header.findIndex((h) => h === name);
      const iClient = col('client');
      const iContact = col('contact person');
      const iVenue = col('location');
      const iPic = col('pic');
      const iStatus = col('status');
      const iDate = col('wedding date');
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        if (!cells || cells.every((c) => !c.trim())) continue;
        const date = parseChineseDate(cells[iDate] ?? '');
        if (!date) continue;
        const venue = (cells[iVenue] ?? '').trim();
        const picRaw = (cells[iPic] ?? '').trim();
        const pics = picRaw
          .split(/[,\n]/)
          .map((p) => mapPic(p.trim()))
          .filter((p): p is string => Boolean(p));
        entries.push({
          client: (cells[iClient] ?? '').trim(),
          contact: (cells[iContact] ?? '').trim(),
          venue,
          venueKey: venueKey(venue),
          pics: [...new Set(pics)].filter((p) => PIC_OPTIONS.includes(p)),
          weddingDate: date.start,
          weddingEnd: date.end,
          status: (cells[iStatus] ?? '').trim(),
        });
      }
      logger.info({ count: entries.length, file }, 'wedding schedule loaded from CSV');
    } else {
      logger.warn({ file }, 'wedding schedule CSV not found — schedule lookups disabled');
    }
  } catch (err) {
    logger.error({ err }, 'failed to load wedding schedule CSV');
  }
  return entries;
}

/** Force a reload on next lookup (e.g. after refreshing the snapshot). */
export function invalidateScheduleCache(): void {
  cache = null;
}

/**
 * Refresh the schedule LIVE from the Notion WEDDING SCHEDULE data source.
 * No-op (returns false) if not configured. On success it replaces the cache, so
 * weddings the team add in Notion are picked up automatically. Safe to call on a
 * timer; falls back to the existing cache/CSV on any error.
 */
export async function refreshFromNotion(): Promise<boolean> {
  const dsId = config.notion.weddingDataSourceId;
  if (!dsId || !config.notion.apiKey) return false;
  try {
    const { Client } = await import('@notionhq/client');
    const { proxyFetch } = await import('../bootstrap.js');
    const notion = new Client({
      auth: config.notion.apiKey,
      ...(proxyFetch ? { fetch: proxyFetch as unknown as typeof fetch } : {}),
    });

    const entries: ScheduleEntry[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await (notion as any).dataSources.query({
        data_source_id: dsId,
        page_size: 100,
        start_cursor: cursor,
      });
      for (const page of res.results as any[]) {
        const p = page.properties ?? {};
        const date = p['Wedding Date']?.date;
        if (!date?.start) continue;
        const venue = richText(p['Location']);
        const pics: string[] = (p['PIC']?.people ?? [])
          .map((u: any) => mapPic(u?.name ?? ''))
          .filter((x: string | null): x is string => Boolean(x));
        entries.push({
          client: title(p['Client']),
          contact: richText(p['Contact Person']),
          venue,
          venueKey: venueKey(venue),
          pics: [...new Set(pics)].filter((x) => PIC_OPTIONS.includes(x)),
          weddingDate: date.start.slice(0, 10),
          weddingEnd: date.end ? date.end.slice(0, 10) : null,
          status: p['Status']?.status?.name ?? '',
        });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    if (entries.length === 0) {
      logger.warn('wedding schedule live refresh returned 0 rows — keeping CSV/cache');
      return false;
    }
    buildIndex(entries);
    liveLoaded = true;
    logger.info({ count: entries.length }, 'wedding schedule refreshed LIVE from Notion');
    return true;
  } catch (err: any) {
    logger.error({ err: err?.code ?? err?.message ?? err }, 'wedding schedule live refresh failed — using CSV/cache');
    return false;
  }
}

function title(prop: any): string {
  return Array.isArray(prop?.title) ? prop.title.map((t: any) => t.plain_text).join('').trim() : '';
}
function richText(prop: any): string {
  return Array.isArray(prop?.rich_text) ? prop.rich_text.map((t: any) => t.plain_text).join('').trim() : '';
}

/** Whether the current cache came from a live Notion read (vs the CSV snapshot). */
export function isLive(): boolean {
  return liveLoaded;
}

export function scheduleLoaded(): boolean {
  return load().entries.length > 0;
}

/** True if `text` names a venue that appears in the schedule (so the expense is a wedding). */
export function isKnownVenue(text: string | null | undefined): boolean {
  const k = venueKey(text);
  if (k.length < 4) return false;
  return load().entries.some((e) => e.venueKey && (e.venueKey.includes(k) || k.includes(e.venueKey)));
}

function venueCandidates(venueText: string): ScheduleEntry[] {
  const k = venueKey(venueText);
  if (k.length < 4) return [];
  const { entries } = load();
  return entries.filter((e) => e.venueKey && (e.venueKey.includes(k) || k.includes(e.venueKey)));
}

/** All weddings at a venue (optionally narrowed by PIC), sorted by nearness to a reference date. */
export function venueWeddings(
  venueText: string | null | undefined,
  opts: { picHint?: string | null; nearISO?: string | null } = {},
): ScheduleEntry[] {
  if (!venueText) return [];
  let cands = venueCandidates(venueText);
  if (opts.picHint && cands.length > 1) {
    const up = opts.picHint.toUpperCase();
    const byPic = cands.filter((e) => e.pics.some((p) => p === up || up.startsWith(p) || p.startsWith(up)));
    if (byPic.length) cands = byPic;
  }
  if (opts.nearISO) {
    cands = [...cands].sort((a, b) => {
      const da = daysBetween(opts.nearISO!, a.weddingDate);
      const db = daysBetween(opts.nearISO!, b.weddingDate);
      // Prefer weddings on/after the reference date; penalise ones well before it.
      const sa = da == null ? Infinity : da >= -3 ? Math.abs(da) : Math.abs(da) + 100;
      const sb = db == null ? Infinity : db >= -3 ? Math.abs(db) : Math.abs(db) + 100;
      return sa - sb;
    });
  }
  return cands;
}

/** Pick this entry's PIC, using a hint to disambiguate multi-PIC weddings. */
export function entryPic(entry: ScheduleEntry, picHint: string | null = null): string | null {
  return pickPic(entry, picHint);
}

function pickPic(entry: ScheduleEntry, picHint: string | null): string | null {
  if (entry.pics.length === 1) return entry.pics[0];
  if (picHint) {
    const up = picHint.toUpperCase();
    const hit = entry.pics.find((p) => p === up || up.startsWith(p) || p.startsWith(up));
    if (hit) return hit;
  }
  return entry.pics[0] ?? null;
}

/**
 * Look up the wedding for an expense. Strategy, in order:
 *  - exact wedding date (+ pic to disambiguate),
 *  - venue + nearest date to the invoice/purchase date,
 *  - venue alone (if unique),
 *  - client name.
 */
export function lookupSchedule(opts: {
  weddingDate?: string | null;
  venueText?: string | null;
  picHint?: string | null;
  clientHint?: string | null;
  invoiceDate?: string | null;
}): ScheduleMatch | null {
  const { byDate } = load();
  const picHint = opts.picHint ?? null;

  // 1) exact wedding date
  if (opts.weddingDate) {
    const sameDay = byDate.get(opts.weddingDate) ?? [];
    if (sameDay.length) {
      const narrowed = opts.venueText
        ? sameDay.filter((e) => {
            const k = venueKey(opts.venueText);
            return k.length >= 4 && (e.venueKey.includes(k) || k.includes(e.venueKey));
          })
        : [];
      const pool = narrowed.length ? narrowed : sameDay;
      const best = pool[0];
      return {
        weddingDate: best.weddingDate,
        pic: pickPic(best, picHint),
        venue: best.venue,
        client: best.client,
        via: 'date',
        confidence: pool.length === 1 ? 0.95 : 0.7,
        alternatives: pool.slice(1),
      };
    }
  }

  // 2) venue (+ nearest date to the invoice date)
  if (opts.venueText) {
    let cands = venueCandidates(opts.venueText);
    if (picHint && cands.length > 1) {
      const up = picHint.toUpperCase();
      const byPic = cands.filter((e) => e.pics.some((p) => p === up || up.startsWith(p) || p.startsWith(up)));
      if (byPic.length) cands = byPic;
    }
    if (cands.length) {
      let best = cands[0];
      let via: ScheduleMatch['via'] = 'venue';
      let confidence = cands.length === 1 ? 0.85 : 0.5;
      if (opts.invoiceDate) {
        // Flowers/goods are bought around the wedding — prefer the closest date,
        // favouring weddings on/after the purchase date.
        const scored = cands
          .map((e) => {
            const diff = daysBetween(opts.invoiceDate!, e.weddingDate);
            const score = diff == null ? Infinity : (diff >= -3 ? Math.abs(diff) : Math.abs(diff) + 100);
            return { e, score, diff };
          })
          .sort((a, b) => a.score - b.score);
        const top = scored[0];
        if (top && Number.isFinite(top.score) && top.score <= 120) {
          best = top.e;
          via = 'venue+date';
          // Confident when one clear nearest date within ~3 weeks.
          const second = scored[1];
          confidence = !second || second.score - top.score > 7 ? 0.9 : 0.6;
        }
      }
      return {
        weddingDate: best.weddingDate,
        pic: pickPic(best, picHint),
        venue: best.venue,
        client: best.client,
        via,
        confidence,
        alternatives: cands.filter((e) => e !== best).slice(0, 4),
      };
    }
  }

  // 3) client name
  if (opts.clientHint) {
    const k = opts.clientHint.toLowerCase().trim();
    if (k.length >= 3) {
      const { entries } = load();
      const cands = entries.filter((e) => e.client.toLowerCase().includes(k));
      if (cands.length) {
        const best = cands[0];
        return {
          weddingDate: best.weddingDate,
          pic: pickPic(best, picHint),
          venue: best.venue,
          client: best.client,
          via: 'client',
          confidence: cands.length === 1 ? 0.7 : 0.4,
          alternatives: cands.slice(1, 5),
        };
      }
    }
  }

  return null;
}
