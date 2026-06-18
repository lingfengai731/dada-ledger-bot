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
- If a grand total is written at the bottom, use it. Otherwise sum the line "Jumlah" values.

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

type RawReceipt = Partial<Receipt> & { items?: Partial<Receipt['items'][number]>[] };

/** Read every receipt in one image OR PDF. Returns [] if none could be parsed. */
export async function extractReceipts(
  base64: string,
  mediaType: string,
): Promise<Receipt[]> {
  const isPdf = mediaType === 'application/pdf';
  const mediaBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [mediaBlock as any, { type: 'text', text: INSTRUCTION }],
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
