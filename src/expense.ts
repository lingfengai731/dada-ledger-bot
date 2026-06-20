import type { Receipt, WeddingNote } from './types.js';

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
  /** Raw PIC name from the note (mapped to a Notion option at write time). */
  pic: string | null;
  /** Raw HANDLER / payer name, mapped at write time. */
  handler: string | null;
  /** Venue / location from the note (used to match the wedding schedule). Not written to Notion. */
  location: string | null;
  /** false → leave the wedding fields blank in Notion. */
  isWedding: boolean;
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

/** Map a free name (sender display name, "TO X", "by X") to a known person, else null. */
export function matchPerson(name: string | null | undefined): string | null {
  if (!name) return null;
  let up = name.trim().toUpperCase();
  if (!up) return null;
  up = PEOPLE_ALIAS[up] ?? up;
  return (
    KNOWN_PEOPLE.find((k) => k === up || up.startsWith(k) || k.startsWith(up) || up.includes(k)) ?? null
  );
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

/**
 * Combine vendor + description into the title, but keep it SHORT (boss's ask):
 * if the note's description already references the receipt vendor (overlapping
 * words, e.g. vendor "Lion Parcel Surabaya" and desc "...to Lion Parcel"), keep
 * just the description. Only join both when each adds new information.
 */
export function combineVendorDescription(vendor: string | null, description: string | null): string | null {
  const v = (vendor ?? '').trim();
  const d = (description ?? '').trim();
  if (!v) return d || null;
  if (!d) return v || null;
  if (v.toLowerCase() === d.toLowerCase()) return d;
  // If half-or-more of the vendor's significant words already appear in the
  // description, the vendor is redundant — drop it.
  const vw = sigWords(v);
  if (vw.length) {
    const dw = new Set(sigWords(d));
    const overlap = vw.filter((w) => dw.has(w)).length;
    if (overlap / vw.length >= 0.5) return d;
  }
  return `${v}, ${d}`;
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
  const vendorDescription = combineVendorDescription(vendor, description);

  // Prefer the printed receipt total; fall back to the amount typed in the note.
  let cost: number | null = receipt?.total ?? null;
  if (cost === null) cost = note.amount;
  if (receipt?.total != null && note.amount != null && receipt.total !== note.amount) {
    warnings.push(
      `Receipt total (${receipt.total}) ≠ amount in note (${note.amount}) — using receipt total.`,
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

  const { handler, conflict } = pickHandler(senderName, receipt?.recipient ?? null, note.buyer);
  if (conflict) warnings.push(conflict);

  return {
    vendorDescription,
    vendor,
    description,
    weddingDate: isWedding ? note.weddingDate : null,
    weddingEnd: null,
    invoiceDate: note.invoiceDate ?? receipt?.date ?? null,
    cost,
    pic: note.pic,
    handler,
    location: note.location,
    isWedding,
    confidence: Math.min(note.confidence, receipt?.confidence ?? 1),
    warnings,
    info: [],
    imagePath,
    rawNote: note.rawText,
  };
}
