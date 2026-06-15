/** One line item on a receipt. */
export interface ReceiptItem {
  /** Item name as written on the receipt, e.g. "Andong Kecap". */
  name: string;
  /** Quantity (Banyaknya / Byk). Null if not legible. */
  quantity: number | null;
  /** Unit price (Harga @). Null if not written. */
  unitPrice: number | null;
  /** Line amount (Jumlah). The number that actually contributes to the total. */
  amount: number | null;
}

/** A structured receipt extracted from one photo by the vision agent. */
export interface Receipt {
  /** Shop / vendor name, e.g. "Fuad Flower Shop". */
  vendor: string | null;
  /** Invoice / Faktur number, e.g. "02728". */
  invoiceNo: string | null;
  /** Receipt date in ISO format (YYYY-MM-DD) if legible, else null. */
  date: string | null;
  /** Who the receipt is addressed to (Kepada / Yth), e.g. "DADA", "JAY". */
  recipient: string | null;
  /** Line items. */
  items: ReceiptItem[];
  /** Grand total in the smallest sensible unit (whole Rupiah). */
  total: number | null;
  /** ISO 4217 currency, defaults to "IDR". */
  currency: string;
  /** Vision model's confidence 0..1 that the extraction is correct. */
  confidence: number;
  /** Free-text notes from the model: anything unclear, multiple receipts, etc. */
  notes: string | null;
}

/**
 * Structured data parsed from the employee's accompanying WhatsApp text message
 * (sent as a SEPARATE message — WhatsApp captions are not used here).
 *
 * Example raw text:
 *   "11/06 Mocha Paper for Burgundy Cones 11 jun lte wed pandhawa 80.000 by Jay"
 * decodes to: weddingDate=2026-06-11, organiser="lte", location="pandhawa",
 *   description="Mocha Paper for Burgundy Cones", amount=80000, buyer="Jay".
 *
 * When a date has several weddings, the employee also writes the PIC
 * (Jay / Christi / Putri) to disambiguate which wedding it belongs to.
 */
export interface WeddingNote {
  /** false for non-wedding expenses (office electricity, accountant, etc.) — wedding fields stay null. */
  isWedding: boolean;
  /** Wedding/event date in ISO YYYY-MM-DD (NOT the invoice date). */
  weddingDate: string | null;
  /** Person in charge of the wedding (Jay / Christi / Putri …) — disambiguates same-day weddings. */
  pic: string | null;
  /** Organiser, often shorthand, e.g. "lte". */
  organiser: string | null;
  /** Venue / location, e.g. "Pandawa". */
  location: string | null;
  /** Who actually made the purchase ("by Jay"). */
  buyer: string | null;
  /** Item / purpose text, e.g. "Mocha Paper for Burgundy Cones". */
  description: string | null;
  /** Amount in whole Rupiah, if the message states one. */
  amount: number | null;
  /** The original message text, kept for audit. */
  rawText: string;
  /** Model confidence 0..1. */
  confidence: number;
  /** Anything unclear / assumptions made. */
  notes: string | null;
}

/** A receipt as stored in the database (adds bookkeeping fields). */
export interface StoredReceipt extends Receipt {
  id: number;
  /** WhatsApp message id the image came from (for dedupe). */
  waMessageId: string;
  /** Sender display name / number. */
  sender: string;
  /** Local path to the saved image. */
  imagePath: string;
  /** Unix epoch (ms) when we processed it. */
  processedAt: number;
  /** Notion page id if synced, else null. */
  notionPageId: string | null;
}
