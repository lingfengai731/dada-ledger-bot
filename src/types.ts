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
