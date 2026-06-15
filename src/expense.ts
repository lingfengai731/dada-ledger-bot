import type { Receipt, WeddingNote } from './types.js';

/**
 * One expense ready to be confirmed and written to Notion's EXPENSES data source.
 * Built by merging what we read from the receipt image with what the employee
 * wrote in the accompanying note.
 */
export interface ExpenseDraft {
  /** Notion title column "VENDOR / DESCRIPTION". */
  vendorDescription: string | null;
  /** "WEDDING DATE" (ISO) — null for non-wedding expenses. */
  weddingDate: string | null;
  /** "INVOICE DATE" (ISO) — from the receipt. */
  invoiceDate: string | null;
  /** "COST" in whole Rupiah. */
  cost: number | null;
  /** Raw PIC name from the note (mapped to a Notion option at write time). */
  pic: string | null;
  /** Raw HANDLER / buyer name ("by X"), mapped at write time. */
  handler: string | null;
  /** false → leave the wedding fields blank in Notion. */
  isWedding: boolean;
  confidence: number;
  /** Things the human should double-check before confirming. */
  warnings: string[];
  /** Provenance, kept for storage / audit. */
  imagePath: string | null;
  rawNote: string;
}

export function mergeToDraft(
  note: WeddingNote,
  receipt: Receipt | null,
  imagePath: string | null,
): ExpenseDraft {
  const warnings: string[] = [];

  const vendorDescription =
    note.description ??
    receipt?.vendor ??
    receipt?.items?.[0]?.name ??
    null;

  // Prefer the printed receipt total; fall back to the amount typed in the note.
  let cost: number | null = receipt?.total ?? null;
  if (cost === null) cost = note.amount;
  if (
    receipt?.total != null &&
    note.amount != null &&
    receipt.total !== note.amount
  ) {
    warnings.push(
      `Receipt total (${receipt.total}) ≠ amount in note (${note.amount}) — using receipt total.`,
    );
  }

  const isWedding = note.isWedding || note.weddingDate != null;
  if (isWedding && !note.weddingDate) warnings.push('Wedding expense but no wedding date detected.');
  if (isWedding && !note.pic) warnings.push('No PIC detected — needed when a date has several weddings.');
  if (cost === null) warnings.push('No amount detected on the receipt or in the note.');
  if (!vendorDescription) warnings.push('No vendor/description detected.');

  return {
    vendorDescription,
    weddingDate: isWedding ? note.weddingDate : null,
    invoiceDate: receipt?.date ?? null,
    cost,
    pic: note.pic,
    handler: note.buyer,
    isWedding,
    confidence: Math.min(note.confidence, receipt?.confidence ?? 1),
    warnings,
    imagePath,
    rawNote: note.rawText,
  };
}
