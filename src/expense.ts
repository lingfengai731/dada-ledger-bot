import type { Receipt, WeddingNote } from './types.js';
import { baliTodayISO } from './util/dates.js';

/**
 * One expense ready to be confirmed and written to Notion's EXPENSES data source.
 * Built by merging what we read from the receipt image with what the employee
 * wrote in the accompanying note.
 */
export interface ExpenseDraft {
  /** Notion title "VENDOR / DESCRIPTION" — computed = vendor + description, comma-joined. */
  vendorDescription: string | null;
  /** Who issued the invoice (from the receipt/PDF). */
  vendor: string | null;
  /** What it's for / the item (from the staff note). */
  description: string | null;
  /** "WEDDING DATE" (ISO) — null for non-wedding expenses. */
  weddingDate: string | null;
  /** Last day of a multi-day wedding (ISO), when the schedule stores a range. */
  weddingEnd: string | null;
  /** "INVOICE DATE" (ISO) — from the receipt. */
  invoiceDate: string | null;
  /** "COST" in whole Rupiah. */
  cost: number | null;
  /** "REIMBURSED" in whole Rupiah — set instead of cost for reimbursements. */
  reimbursed: number | null;
  /** true when this is Ling reimbursing a staff member (writes REIMBURSED, no COST/PIC/wedding). */
  isReimbursement: boolean;
  /** true when the note marks this as a supplier bill LING must pay herself → ticks
   *  the "For Ling Payment?" checkbox. Still a normal ledger row (COST written). */
  forLingPayment: boolean;
  /** Raw PIC name from the note (mapped to a Notion option at write time). */
  pic: string | null;
  /** Raw HANDLER / payer name, mapped at write time. */
  handler: string | null;
  /** Venue / location from the note (used to match the wedding schedule). Not written to Notion. */
  location: string | null;
  /** false → leave the wedding fields blank in Notion. */
  isWedding: boolean;
  /** Maps to the AUTO-LEDGER "EXPENSE TYPE" select (Wedding/Shop/General). */
  expenseType: 'wedding' | 'shop' | 'general' | 'reimbursement';
  confidence: number;
  /** Things the human should double-check before confirming. */
  warnings: string[];
  /** What the bot auto-filled (schedule/context lookups), shown for sanity-check. */
  info: string[];
  /** Provenance, kept for storage / audit. */
  imagePath: string | null;
  rawNote: string;
}

// Known DADA people, for matching a message sender / invoice recipient to a handler.
const KNOWN_PEOPLE = [
  'LING', 'JAY', 'CHRISTI', 'PUTRI', 'GENERAL', 'RANIA', 'HIRA', 'MINGGU',
  'PUTU', 'MADE', 'JESICHA', 'JESSICA', 'HAMZAH', 'KENT',
];
const PEOPLE_ALIAS: Record<string, string> = {
  CHRISTY: 'CHRISTI', CHRISTIE: 'CHRISTI', ANDRIAN: 'CHRISTI',
  JESICCA: 'JESICHA', JESSICHA: 'JESICHA',
};

/** A staff mark that this is a supplier bill LING must pay herself (NOT that Ling
 *  already paid it). Ticks Notion's "For Ling Payment?" checkbox; the expense still
 *  posts to the ledger as normal. Matches "for ling payment", "ling to pay", "to be
 *  paid by ling", "ling payment" — but NOT "by/trf ling" (that's the handler). */
const LING_PAYMENT_RE =
  /\bfor\s+ling(?:'?s)?\s+pay(?:ment)?\b|\bling\s+to\s+pay\b|\bto\s+be\s+paid\s+by\s+ling\b|\bling\s+pay(?:ment)?\b/i;

export function isForLingPayment(text: string | null | undefined): boolean {
  return Boolean(text && LING_PAYMENT_RE.test(text));
}

/** Remove the "for ling payment" mark from a title so it doesn't pollute VENDOR/DESCRIPTION. */
function stripLingPaymentMark(s: string | null): string | null {
  if (!s) return s;
  const cleaned = s.replace(LING_PAYMENT_RE, '').replace(/\s{2,}/g, ' ').replace(/[\s,·-]+$/, '').trim();
  return cleaned || s;
}

/** Map a free name (sender display name, "TO X", a transfer's full name) to a known person. */
export function matchPerson(name: string | null | undefined): string | null {
  if (!name) return null;
  const raw = name.trim().toUpperCase();
  if (!raw) return null;
  const tryOne = (t: string): string | null => {
    const up = PEOPLE_ALIAS[t] ?? t;
    // Exact, or one is a prefix of the other (min 4 chars) — NO loose substring
    // matching, or "LING" would match inside "rosaLINGga".
    return (
      KNOWN_PEOPLE.find(
        (k) => k === up || (up.length >= 4 && k.startsWith(up)) || (k.length >= 4 && up.startsWith(k)),
      ) ?? null
    );
  };
  // Whole string first, then each token — handles bank names like
  // "ANDRIAN ROSALINGGA CHRIS" (→CHRISTI) or "RADEN RORO PUTRI RADITYA" (→PUTRI).
  const whole = tryOne(raw);
  if (whole) return whole;
  for (const tok of raw.split(/\s+/)) {
    if (tok.length < 3) continue;
    const m = tryOne(tok);
    if (m) return m;
  }
  return null;
}

/** Tidy a bank-transfer name for display: known person → canonical, else Title Case. */
function displayPerson(raw: string | null): string {
  const known = matchPerson(raw);
  if (known) return known;
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || '???';
}

/**
 * A reimbursement — Ling paying a staff member back (boss's spec, final):
 * title "Reimbursement <name>", PIC is always LING (she made the payment),
 * HANDLER is the staff member being reimbursed, amount into REIMBURSED (not
 * COST), EXPENSE TYPE = Reimbursement, and the invoice date comes from the
 * transfer image — else the day it was posted.
 */
export function buildReimbursementDraft(
  recipientRaw: string | null,
  amount: number | null,
  imagePath: string | null,
  rawNote = '',
  invoiceDate: string | null = null,
): ExpenseDraft {
  const who = displayPerson(recipientRaw);
  const warnings: string[] = [];
  if (amount == null) warnings.push('Could not read the transfer amount — please check.');
  if (who === '???') warnings.push('Who was reimbursed? Reply with the staff name.');
  return {
    vendorDescription: who === '???' ? 'Reimbursement' : `Reimbursement ${who}`,
    vendor: 'Reimbursement',
    description: who,
    weddingDate: null,
    weddingEnd: null,
    invoiceDate: invoiceDate ?? baliTodayISO(),
    cost: null,
    reimbursed: amount,
    isReimbursement: true,
    forLingPayment: false,
    pic: 'LING', // boss: PIC is always Ling (she made the payment)…
    handler: who === '???' ? null : who, // …and HANDLER is the staff reimbursed
    location: null,
    isWedding: false,
    expenseType: 'reimbursement',
    confidence: 0.9,
    warnings,
    info: [],
    imagePath,
    rawNote,
  };
}

/**
 * Handler = who paid / should be reimbursed. No single signal is 100% reliable,
 * so we weigh three: the invoice "TO X" recipient, a "by/tf/trf X" name in the
 * note, and the message sender (whoever posted the bill). Each known person gets
 * a weighted vote; the top scorer wins. When signals disagree we return a note
 * so the human can confirm. Falls back to the raw buyer so nothing is dropped.
 */
function pickHandler(
  senderName: string | null,
  recipient: string | null,
  buyer: string | null,
): { handler: string | null; conflict: string | null } {
  const signals: { who: string; w: number; src: string }[] = [];
  const add = (raw: string | null, w: number, src: string) => {
    const m = matchPerson(raw);
    if (m) signals.push({ who: m, w, src });
  };
  add(recipient, 1.2, 'invoice TO'); // most objective
  add(buyer, 1.0, 'note');           // staff's explicit payer
  add(senderName, 0.9, 'sender');    // who posted it

  if (!signals.length) return { handler: buyer ?? recipient ?? null, conflict: null };

  const score: Record<string, number> = {};
  const srcs: Record<string, string[]> = {};
  for (const s of signals) {
    score[s.who] = (score[s.who] ?? 0) + s.w;
    (srcs[s.who] ??= []).push(s.src);
  }
  const ranked = Object.keys(score).sort((a, b) => score[b] - score[a]);
  const handler = ranked[0];
  const others = ranked.slice(1);
  const conflict = others.length
    ? `Handler set to ${handler} (${srcs[handler].join(' + ')}); also saw ${others.join(', ')} — reply to change if wrong.`
    : null;
  return { handler, conflict };
}

function sigWords(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

// Boss: a summary read off an invoice must stay short — cap the title at 7 words.
const TITLE_MAX_WORDS = 7;

function capWords(s: string, max = TITLE_MAX_WORDS): string {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length <= max ? s : words.slice(0, max).join(' ');
}

/**
 * Combine vendor + description into the title, but keep it SHORT (boss's ask):
 * if the note's description already references the receipt vendor (overlapping
 * words, e.g. vendor "Lion Parcel Surabaya" and desc "...to Lion Parcel"), keep
 * just the description. Only join both when each adds new information. The
 * result is capped at TITLE_MAX_WORDS words (long invoice item lists get cut).
 */
export function combineVendorDescription(vendor: string | null, description: string | null): string | null {
  const v = (vendor ?? '').trim();
  const d = (description ?? '').trim();
  if (!v) return d ? capWords(d) : null;
  if (!d) return v ? capWords(v) : null;
  if (v.toLowerCase() === d.toLowerCase()) return capWords(d);
  // If half-or-more of the vendor's significant words already appear in the
  // description, the vendor is redundant — drop it.
  const vw = sigWords(v);
  if (vw.length) {
    const dw = new Set(sigWords(d));
    const overlap = vw.filter((w) => dw.has(w)).length;
    if (overlap / vw.length >= 0.5) return capWords(d);
  }
  // Joining both: if over budget, shorten the VENDOR (keep a 2-word handle) so the
  // item words — the part that says what was bought — survive the cap.
  const joined = `${v}, ${d}`;
  if (joined.split(/\s+/).length <= TITLE_MAX_WORDS) return joined;
  return capWords(`${capWords(v, 2).replace(/,$/, '')}, ${d}`);
}

/** Recompute the combined title after vendor/description change (e.g. a correction). */
export function recomputeVendorDescription(draft: ExpenseDraft): void {
  draft.vendorDescription = combineVendorDescription(draft.vendor, draft.description);
}

export function mergeToDraft(
  note: WeddingNote,
  receipt: Receipt | null,
  imagePath: string | null,
  senderName: string | null = null,
): ExpenseDraft {
  const warnings: string[] = [];

  const vendor = receipt?.vendor ?? null;
  const description = note.description ?? receipt?.items?.[0]?.name ?? null;
  // "For Ling Payment?" — a supplier bill Ling pays herself. Read from the raw note.
  const forLingPayment = isForLingPayment(note.rawText) || isForLingPayment(description) || isForLingPayment(note.notes);
  const vendorDescription = forLingPayment
    ? stripLingPaymentMark(combineVendorDescription(vendor, description))
    : combineVendorDescription(vendor, description);

  // Boss's rule: the amount the staff TYPED always wins — invoices carry many
  // numbers (fees, subtotals, VAT) and the photo reader can grab the wrong one
  // (e.g. read 1.130.000 and miss the 2.500 fee of a 1.132.500 transfer). The
  // receipt total is only a cross-check: warn on mismatch, keep the typed amount.
  let cost: number | null = note.amount ?? receipt?.total ?? null;
  if (receipt?.total != null && note.amount != null && receipt.total !== note.amount) {
    warnings.push(
      `Receipt shows ${receipt.total} but your note says ${note.amount} — using your typed amount.`,
    );
  }

  const isWedding = note.category === 'wedding' || note.isWedding;
  if (isWedding && !note.weddingDate) warnings.push('Wedding expense but no wedding date detected.');
  if (cost === null) warnings.push('No amount detected on the receipt or in the note.');
  if (!vendorDescription) warnings.push('No vendor/description detected.');
  if (cost != null && cost > 0 && cost < 1000) {
    warnings.push(`Amount looks very low (${cost}) — a thousands separator may be missing (e.g. ${cost} vs ${cost}.000). Please double-check.`);
  }
  if (receipt && typeof receipt.confidence === 'number' && receipt.confidence < 0.55) {
    warnings.push('The photo was hard to read clearly — please check the amount, or resend a sharper photo.');
  }

  // "for ling payment" = Ling pays the bill herself → the HANDLER is automatically
  // LING (boss's rule; distinct from reimbursements, where HANDLER = the staff).
  const { handler: picked, conflict } = pickHandler(senderName, receipt?.recipient ?? null, note.buyer);
  const handler = forLingPayment ? 'LING' : picked;
  if (conflict && !forLingPayment) warnings.push(conflict);

  return {
    vendorDescription,
    vendor,
    description,
    weddingDate: isWedding ? note.weddingDate : null,
    weddingEnd: null,
    // Boss: prioritise the date printed on the receipt; fall back to what staff
    // typed (e.g. the "inv dd/mm" workaround) only when the photo has none. Blank
    // is fine — staff can add it in a correction; it never blocks saving.
    invoiceDate: receipt?.date ?? note.invoiceDate ?? null,
    cost,
    reimbursed: null,
    isReimbursement: false,
    forLingPayment,
    pic: note.pic,
    handler,
    location: note.location,
    isWedding,
    expenseType: isWedding ? 'wedding' : note.category === 'shop' ? 'shop' : 'general',
    confidence: Math.min(note.confidence, receipt?.confidence ?? 1),
    warnings,
    info: [],
    imagePath,
    rawNote: note.rawText,
  };
}
