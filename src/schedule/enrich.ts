import type { ExpenseDraft } from '../expense.js';
import { lookupSchedule, isKnownVenue, venueWeddings, entryPic } from './weddingSchedule.js';
import { rememberWedding, inferFromContext } from './contextMemory.js';
import { logger } from '../logger.js';

/**
 * Make a draft "smart": use the venue to decide it's a wedding, then fill in a
 * missing WEDDING DATE / PIC from the WEDDING SCHEDULE, falling back to recent
 * same-day/same-venue context from colleagues. Boss's rule: a wedding expense
 * MUST end up with both a wedding date and a PIC (person in charge) — otherwise the
 * summary shows ??? and submission is blocked until staff fill them in.
 */

const MISSING = '???';

/** Fields the staff still must supply before a wedding expense can be saved. */
export function missingRequired(draft: ExpenseDraft): string[] {
  if (!draft.isWedding) return [];
  const missing: string[] = [];
  if (!draft.weddingDate) missing.push('wedding date');
  if (!draft.pic) missing.push('PIC');
  return missing;
}

export function displayWeddingDate(draft: ExpenseDraft): string {
  return draft.weddingDate ?? MISSING;
}
export function displayPic(draft: ExpenseDraft): string {
  return draft.pic ?? MISSING;
}

/** Rebuild the double-check warnings that depend on post-enrichment state. */
function recomputeWarnings(draft: ExpenseDraft): void {
  // Drop the stale "no wedding date" / "no vendor" / "no amount" notes; keep the rest.
  draft.warnings = draft.warnings.filter(
    (w) =>
      !/wedding date/i.test(w) &&
      !/organiser/i.test(w) &&
      !w.startsWith('No vendor') &&
      !w.startsWith('No amount'),
  );
  if (draft.cost == null) draft.warnings.push('No amount detected on the receipt or in the note.');
  if (!draft.vendorDescription) draft.warnings.push('No vendor/description detected.');
}

/**
 * Enrich a single draft in place. Returns short human-readable notes about what
 * the bot filled in (shown in the summary so staff can sanity-check).
 */
export function enrichDraft(draft: ExpenseDraft): string[] {
  const notes: string[] = [];

  // 1) A known venue means this is a wedding, even if the parser said otherwise.
  if (!draft.isWedding && isKnownVenue(draft.location)) {
    draft.isWedding = true;
    notes.push(`Treated as a wedding (venue "${draft.location}" is on the schedule).`);
  }

  if (draft.isWedding) {
    // 2a) VENUE-FIRST: the venue identifies which wedding. It outranks a
    // staff-typed date, because a (e.g.) Komaneka receipt cannot belong to a
    // wedding held somewhere else — even if the typed date coincidentally
    // matches another venue's wedding that day.
    const venues = isKnownVenue(draft.location)
      ? venueWeddings(draft.location, { picHint: draft.pic, nearISO: draft.invoiceDate ?? draft.weddingDate })
      : [];

    if (venues.length) {
      const datesAtVenue = new Set(venues.map((e) => e.weddingDate));
      const target = venues[0];
      if (!draft.weddingDate) {
        draft.weddingDate = target.weddingDate;
        notes.push(`Wedding date set to ${target.weddingDate} from the schedule (${target.client || target.venue}).`);
      } else if (!datesAtVenue.has(draft.weddingDate)) {
        notes.push(
          `Wedding date adjusted to ${target.weddingDate} from the schedule (${target.client || target.venue}) — ` +
            `the note said ${draft.weddingDate}, but there's no wedding at ${target.venue} that day. Correct me if wrong.`,
        );
        draft.weddingDate = target.weddingDate;
      }
      if (!draft.pic) {
        const p = entryPic(target, draft.pic);
        if (p) {
          draft.pic = p;
          notes.push(`PIC set to ${p} from the schedule (${target.client || target.venue}).`);
        }
      }
      const otherDates = [...new Set(venues.map((e) => e.weddingDate))].filter((d) => d !== draft.weddingDate);
      if (otherDates.length) {
        const shown = otherDates.slice(0, 3).join(', ');
        const more = otherDates.length > 3 ? ` (+${otherDates.length - 3} more)` : '';
        notes.push(`Note: ${target.venue} also has weddings on ${shown}${more}. Correct me if this is the wrong one.`);
      }
      logger.info({ via: 'venue', venue: target.venue, weddingDate: draft.weddingDate }, 'venue-first enrich');
    }

    const needDate = !draft.weddingDate;
    const needPic = !draft.pic;

    if (needDate || needPic) {
      // 2b) No venue match — fall back to exact-date / client lookup.
      const match = lookupSchedule({
        weddingDate: draft.weddingDate,
        venueText: draft.location,
        picHint: draft.pic,
        invoiceDate: draft.invoiceDate,
      });

      if (match && match.confidence >= 0.6) {
        if (needDate && match.weddingDate) {
          draft.weddingDate = match.weddingDate;
          notes.push(
            `Wedding date set to ${match.weddingDate} from the schedule (${match.client || match.venue}).`,
          );
        }
        if (needPic && match.pic) {
          draft.pic = match.pic;
          notes.push(`PIC set to ${match.pic} from the schedule (${match.client || match.venue}).`);
        }
        if (match.alternatives.length) {
          notes.push(
            `Note: other weddings also match — ${match.alternatives
              .map((a) => `${a.weddingDate}${a.pics[0] ? ' ' + a.pics[0] : ''}`)
              .join(', ')}. Correct me if this is wrong.`,
          );
        }
        logger.info({ via: match.via, confidence: match.confidence }, 'schedule enriched draft');
      }

      // 3) Fall back to recent colleague context for anything still missing.
      if (!draft.weddingDate || !draft.pic) {
        const ctx = inferFromContext({
          invoiceDate: draft.invoiceDate,
          venueText: draft.location,
          picHint: draft.pic,
        });
        if (ctx) {
          if (!draft.weddingDate && ctx.weddingDate) {
            draft.weddingDate = ctx.weddingDate;
            notes.push(`Wedding date guessed as ${ctx.weddingDate} (${ctx.reason}).`);
          }
          if (!draft.pic && ctx.pic) {
            draft.pic = ctx.pic;
            notes.push(`PIC guessed as ${ctx.pic} (${ctx.reason}).`);
          }
        }
      }
    }

    // 4) Remember this wedding so colleagues' later same-day notes can borrow it.
    if (draft.weddingDate) {
      rememberWedding({
        invoiceDate: draft.invoiceDate,
        venueText: draft.location,
        weddingDate: draft.weddingDate,
        pic: draft.pic,
      });
    }
  }

  recomputeWarnings(draft);
  draft.info = notes;
  return notes;
}
