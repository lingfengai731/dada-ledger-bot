import { claude, MODEL } from '../llm/claude.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Receipt } from '../types.js';

const SYSTEM = `You are a meticulous bookkeeping assistant for "DADA Island".
You read photographs of handwritten purchase receipts (mostly from "Fuad Flower Shop"
in Bali, Indonesia) and turn them into clean structured data.

Receipt layout vocabulary (Indonesian):
- "Faktur No." = invoice number
- "Tanggal" = date (often written like 06-06-2026 or 8-6-26 = 8 June 2026)
- "Kepada" / "Yth" = recipient (who it's billed to: DADA, JAY, etc.)
- "Banyaknya" / "Byk" = quantity
- "Nama Barang" = item name
- "Harga @" = unit price
- "Jumlah" = line amount (this is what sums into the total)

CRITICAL number rules:
- Indonesian uses "." as the THOUSANDS separator. "500.000" means 500000 (five hundred
  thousand), NOT 500. "1.360.000" means 1360000. Always output plain integers in whole Rupiah.
- For "total", use the FINAL GRAND TOTAL (the bottom-line "Total" / "Grand Total" /
  "Jumlah Total" / "Total Due" — usually the largest figure). Do NOT use a deposit, a
  down-payment ("DP"), a subtotal, tax, or a single line item as the total. On a typed
  PDF invoice with many rows, the grand total is the summed amount at the very bottom.
  Only if no grand total is printed, sum the line "Jumlah" values.

IMPORTANT: one photo may contain MULTIPLE separate receipts (often two side by side).
Return one object per distinct receipt.

If something is illegible, set that field to null and explain in "notes". Never invent numbers.
Give an honest "confidence" between 0 and 1 for each receipt.`;

const INSTRUCTION = `Extract every receipt/invoice visible in this file (it may be a photo or a PDF invoice).

Respond with ONLY a JSON object (no markdown, no commentary) of this exact shape:
{
  "receipts": [
    {
      "vendor": string | null,
      "invoiceNo": string | null,
      "date": string | null,            // ISO "YYYY-MM-DD"
      "recipient": string | null,
      "items": [
        { "name": string, "quantity": number | null, "unitPrice": number | null, "amount": number | null }
      ],
      "total": number | null,           // whole Rupiah integer
      "confidence": number,             // 0..1
      "notes": string | null
    }
  ]
}`;

// Reimbursement mode: the image is a BANK TRANSFER screenshot, not a receipt.
const TRANSFER_SYSTEM = `You read screenshots of Indonesian bank transfers that "DADA Island" uses to
record REIMBURSEMENTS — the company (STUDIO DADA BALI) paying money back to a staff member.

A screenshot may contain ONE or SEVERAL transfers. Each transfer block shows:
- a heading like "Domestic Transfer" / "Transfer",
- an amount like "IDR 1,285,230.00" (the money sent),
- "From ... STUDIO DADA BALI ..." (always the company — IGNORE this),
- "To  <account> <PERSON NAME>" (the staff member being reimbursed — THIS is who we want).

CRITICAL number rules: amounts use "," as thousands and "." before the cents.
"IDR 1,285,230.00" = 1285230 rupiah. "4,517,500.00" = 4517500. Output whole-rupiah integers (drop cents).

Return ONE object per transfer. Never invent transfers or amounts.`;

const TRANSFER_INSTRUCTION = `Extract every bank transfer in this screenshot.

Respond with ONLY a JSON object (no markdown) of this exact shape:
{
  "receipts": [
    {
      "vendor": "Reimbursement",
      "recipient": string | null,   // the "To" person's name (who is reimbursed)
      "total": number | null,       // the transferred amount, whole Rupiah
      "items": [],
      "confidence": number,
      "notes": string | null
    }
  ]
}`;

type RawReceipt = Partial<Receipt> & { items?: Partial<Receipt['items'][number]>[] };

/** Read every receipt (or, in 'reimbursement' mode, bank transfer) in one image/PDF. */
export async function extractReceipts(
  base64: string,
  mediaType: string,
  mode: 'receipt' | 'reimbursement' = 'receipt',
): Promise<Receipt[]> {
  const isPdf = mediaType === 'application/pdf';
  const mediaBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: mode === 'reimbursement' ? TRANSFER_SYSTEM : SYSTEM,
    messages: [
      {
        role: 'user',
        content: [mediaBlock as any, { type: 'text', text: mode === 'reimbursement' ? TRANSFER_INSTRUCTION : INSTRUCTION }],
      },
    ],
  });

  const text = response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();

  const parsed = safeParse(text);
  if (!parsed) {
    logger.warn({ text }, 'vision agent returned unparseable output');
    return [];
  }

  return (parsed.receipts ?? []).map(normalizeReceipt);
}

function safeParse(text: string): { receipts: RawReceipt[] } | null {
  // Tolerate accidental ```json fences or leading prose.
  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const digits = v.replace(/[^\d]/g, '');
    return digits ? Number.parseInt(digits, 10) : null;
  }
  return null;
}

function normalizeReceipt(r: RawReceipt): Receipt {
  const items = (r.items ?? []).map((it) => ({
    name: String(it?.name ?? '').trim() || 'unknown',
    quantity: num(it?.quantity),
    unitPrice: num(it?.unitPrice),
    amount: num(it?.amount),
  }));

  // If no total was given, fall back to summing line amounts.
  let total = num(r.total);
  if (total === null) {
    const sum = items.reduce((acc, it) => acc + (it.amount ?? 0), 0);
    total = sum > 0 ? sum : null;
  }

  return {
    vendor: (r.vendor as string) ?? null,
    invoiceNo: (r.invoiceNo as string) ?? null,
    date: (r.date as string) ?? null,
    recipient: (r.recipient as string) ?? null,
    items,
    total,
    currency: config.currency,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
    notes: (r.notes as string) ?? null,
  };
}
