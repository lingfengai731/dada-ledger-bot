import { claude, MODEL } from '../llm/claude.js';
import { logger } from '../logger.js';
import { todayISO } from '../util/dates.js';
import type { WeddingNote } from '../types.js';

/**
 * Parses the employee's short-form WhatsApp text that accompanies a receipt
 * photo, into structured wedding/expense fields. This is the second half of the
 * "read the receipt together with the message" requirement.
 *
 * Known vocabulary (extend KNOWN_* lists as the team confirms them):
 *  - PIC / staff:   Jay, Christi, Putri, Ling, Made, Rania, Siu, Iputu …
 *  - shorthand:     wed = wedding, lte = an organiser, pandawa/pandhawa = venue
 *  - dates:         "11/6", "11 jun" → 11 June (resolve year from today)
 */
// Real staff names from the Notion schema (PIC + HANDLER option lists).
const KNOWN_PIC = ['Ling', 'Jay', 'Christi', 'Putri', 'General', 'Kent', 'Rania'];
const KNOWN_STAFF = [
  ...KNOWN_PIC, 'Minggu', 'Putu', 'Made', 'Jesicha', 'Hamzah', 'Jessica',
];

function buildSystem(): string {
  return `You parse short, abbreviated WhatsApp messages written by DADA Island staff
(a wedding decor / florist business in Bali, Indonesia) that accompany a purchase receipt.

Today is ${todayISO()}. Amounts are Indonesian Rupiah; "." is the THOUSANDS separator
("80.000" = 80000). Resolve dates like "11/6" or "11 jun" to the nearest sensible
ISO date (YYYY-MM-DD) — prefer the current or upcoming year, not a far past one.

Vocabulary you will see (staff write in short form):
- "wed" = wedding
- A wedding is identified by its DATE plus, when several weddings fall on one day,
  the PIC (person in charge): one of ${KNOWN_PIC.join(', ')} (or a similar staff name).
- There is also an organiser (often shorthand, e.g. "lte") and a location/venue
  (e.g. "Pandawa"/"pandhawa").
- "by <name>" = who made the purchase (the buyer). Known staff: ${KNOWN_STAFF.join(', ')}.
- A leading trigger keyword like "exp" just flags this as an expense submission — ignore it.
- The rest is usually the item and what it's for (e.g. "Mocha Paper for Burgundy Cones").

WEDDING vs NOT — important: this is a wedding decor/florist business, so MOST expenses
are for a wedding. Set isWedding=TRUE whenever the note has ANY of: a venue/location
(e.g. pandawa), a PIC/person name, or a date that looks like an event date — even if the
word "wed" is absent. Only set isWedding=FALSE for clearly general/office expenses such as
office electricity, office supplies, toilet rolls/tissues, accountant, staff lunch/breakfast/
snack, fuel, or motorcycle service.

DESCRIPTION: use the literal item/purpose words from the note (e.g. "jahit kain",
"welcome sign fabric"). Do NOT translate, rename, or invent a vendor.

DATES: if two dates appear, the WEDDING date is the event date — put it in weddingDate and
mention the other date in notes.

Never invent values. If a field isn't present, use null and note it. Give an honest confidence 0..1.`;
}

const INSTRUCTION = `Parse this message. Respond with ONLY a JSON object of this exact shape:
{
  "isWedding": boolean,
  "weddingDate": string | null,   // ISO YYYY-MM-DD
  "pic": string | null,
  "organiser": string | null,
  "location": string | null,
  "buyer": string | null,
  "description": string | null,
  "amount": number | null,        // whole Rupiah integer
  "confidence": number,
  "notes": string | null
}`;

export async function parseEmployeeNote(rawText: string): Promise<WeddingNote> {
  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(),
    messages: [{ role: 'user', content: `${INSTRUCTION}\n\nMessage:\n"""${rawText}"""` }],
  });

  const text = response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();

  const parsed = safeParse(text);
  if (!parsed) {
    logger.warn({ text }, 'message parser returned unparseable output');
    return emptyNote(rawText);
  }

  return {
    isWedding: Boolean(parsed.isWedding),
    weddingDate: str(parsed.weddingDate),
    pic: str(parsed.pic),
    organiser: str(parsed.organiser),
    location: str(parsed.location),
    buyer: str(parsed.buyer),
    description: str(parsed.description),
    amount: num(parsed.amount),
    rawText,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    notes: str(parsed.notes),
  };
}

function emptyNote(rawText: string): WeddingNote {
  return {
    isWedding: false,
    weddingDate: null,
    pic: null,
    organiser: null,
    location: null,
    buyer: null,
    description: null,
    amount: null,
    rawText,
    confidence: 0,
    notes: 'could not parse',
  };
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const d = v.replace(/[^\d]/g, '');
    return d ? Number.parseInt(d, 10) : null;
  }
  return null;
}

function safeParse(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
