import { venueKey } from './weddingSchedule.js';
import { logger } from '../logger.js';

/**
 * Short-term context memory. On any given day several staff post receipts for
 * the SAME wedding; some write the wedding date / PIC, others don't. When we
 * resolve a wedding (from a note that stated it, or from the schedule) we
 * remember it here, so a later note that omits the date/PIC can borrow it.
 *
 * In-memory and rolling (last ~14 days) — the schedule remains the source of
 * truth; this just smooths over same-day omissions between colleagues.
 */

interface CtxEntry {
  ts: number;
  invoiceDate: string | null;
  venueKey: string;
  weddingDate: string;
  pic: string | null;
}

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 400;
const entries: CtxEntry[] = [];

function prune(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  while (entries.length && entries[0].ts < cutoff) entries.shift();
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Record a resolved wedding so colleagues' later notes can infer from it. */
export function rememberWedding(opts: {
  invoiceDate: string | null;
  venueText: string | null;
  weddingDate: string;
  pic: string | null;
}): void {
  entries.push({
    ts: Date.now(),
    invoiceDate: opts.invoiceDate,
    venueKey: venueKey(opts.venueText),
    weddingDate: opts.weddingDate,
    pic: opts.pic,
  });
  prune();
}

/**
 * Infer a missing wedding date / PIC from recent context. Strongest signal is a
 * matching venue; failing that, a colleague's expense on the same invoice date.
 */
export function inferFromContext(opts: {
  invoiceDate: string | null;
  venueText: string | null;
  picHint: string | null;
}): { weddingDate: string; pic: string | null; reason: string } | null {
  prune();
  const vk = venueKey(opts.venueText);

  // 1) same venue → same wedding (most reliable)
  if (vk.length >= 4) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.venueKey && (e.venueKey.includes(vk) || vk.includes(e.venueKey))) {
        logger.info({ via: 'context-venue', weddingDate: e.weddingDate }, 'inferred wedding from context');
        return { weddingDate: e.weddingDate, pic: opts.picHint ? null : e.pic, reason: 'same venue as a recent expense' };
      }
    }
  }

  // 2) same purchase date + matching PIC (when the staff did name a PIC)
  if (opts.invoiceDate && opts.picHint) {
    const up = opts.picHint.toUpperCase();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.invoiceDate === opts.invoiceDate && e.pic && (e.pic === up || up.startsWith(e.pic) || e.pic.startsWith(up))) {
        logger.info({ via: 'context-date+pic', weddingDate: e.weddingDate }, 'inferred wedding from context');
        return { weddingDate: e.weddingDate, pic: e.pic, reason: 'same day & PIC as a recent expense' };
      }
    }
  }

  return null;
}
