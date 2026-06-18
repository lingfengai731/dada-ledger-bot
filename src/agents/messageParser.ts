import { claude, MODEL } from '../llm/claude.js';
import { logger } from '../logger.js';
import { baliTodayISO } from '../util/dates.js';
import type { WeddingNote } from '../types.js';

/**
 * Parses the employee's short WhatsApp note (sent with or near a receipt photo)
 * into structured fields. Tuned from real DADA - Financial Report Group messages.
 */

// PIC = current wedding leads (KENT/RANIA excluded per boss). STAFF = everyone who may pay.
const PIC_OPTIONS = ['LING', 'JAY', 'CHRISTI', 'PUTRI', 'GENERAL'];
const STAFF = [...PIC_OPTIONS, 'RANIA', 'MINGGU', 'PUTU', 'MADE', 'JESICHA', 'HAMZAH', 'JESSICA', 'ANTA WAYAN', 'IPUTU'];
const VENUES = [
  'Pandawa', 'Komaneka', 'Komaneka Keramas', 'Samabe', 'The Seed', 'Lombok', 'Ungasan',
  'Alila Uluwatu', 'Soori', 'Villa Vedas', 'Villa Pemutih', 'Khayangan', 'Glamp Nusa',
  'Ayana', 'Ayana Sky', 'Four Seasons Jimbaran', 'W Seminyak', 'Conrad', 'Wonderland Uluwatu',
  'Mandapa Ubud', 'Raffles', 'Maya', 'Six Senses', 'Tirtha', 'Ritz-Carlton', 'Stone Uluwatu',
  'Noku Beach House', 'Bambu Indah', 'Canggu Wooden', 'Plenilunio', 'Jeeva Saba', 'Mulia',
  'Umana', 'Potato Head',
];

function buildSystem(): string {
  return `You parse short WhatsApp notes from DADA Island staff (a wedding decor/florist
business in Bali, Indonesia) that accompany purchase receipts. Extract clean structured data.

Today is ${baliTodayISO()} (Bali / WITA time — that is the staff's "now"). All dates are
in 2026 unless a year is written. Money uses "." or "," as the THOUSANDS separator:
"82,500" = 82500, "2.115.750" = 2115750, "1,029,665" = 1029665. Output integers.

DATE FORMAT VARIES BY PERSON: some write month/day ("06/13"), others day/month ("13/06").
Both mean 13 June. Use the value that yields a valid 2026 date; when ambiguous, prefer the
near-future or recent date. Output ISO YYYY-MM-DD.
- 4-DIGIT dates with no separator: "0620" = 20 June, "0611" = 11 June (MMDD or DDMM — pick the valid one).
- MONTH NAMES appear in English and Indonesian: jan/januari, feb/februari, mar/maret, apr/april,
  may/mei, jun/juni, jul/juli, aug/agustus, sep/september, oct/oktober, nov/november, dec/desember.
  "9 JUNI 2026" = 2026-06-09, "1 may" = 2026-05-01.

TWO DATES: many notes contain two dates in the pattern
   <invoice/purchase date>  <item>  <wedding/event date>  <amount>  <person> (<location>)
The FIRST date is the invoiceDate (when bought); the SECOND date is the weddingDate (the event).
Example: "06/15 gosend kyea 06/16 115,500 putu (komaneka)" → invoiceDate 2026-06-15,
weddingDate 2026-06-16. If only one date appears, treat it as the invoiceDate (and the
weddingDate only if the text clearly refers to an event).

CATEGORY — set exactly one:
- "general": clearly NOT a wedding — markers include "(General)", "studio", "office",
  "Reimbursement", "for stocks". Leave weddingDate null.
- "shop": for the retail shop — markers include "for shop", "shop=", "Wish for shop". weddingDate null.
- "wedding": everything else (the default for this business). It IS a wedding when there's a
  venue, a wedding date, or a PIC. A VENUE is any hotel/villa/resort/estate/place name —
  often in parentheses, e.g. "(komaneka)", "(pandawa)", "(samabe)", "(The Seed)". When you
  see such a place name, set category "wedding" and put it in "location" (even if no wedding
  date is written — the wedding date can be filled in later from the schedule).

LOCATION & PIC:
- "(pandawa)" → location only.
- "(Pandawa-jessica)" or "(Pandawa-Christy)" → location is before the dash, PIC is after it.
- "for 22nd June Samabe" → wedding date + venue (Samabe).
- "0620 ling's" → "ling's" implies PIC Ling.
- VENUE OFTEN APPEARS IN FREE TEXT, not just in parentheses:
  "15/04 Cream fabric for curtain drapes 19th conrad wedding" → location "Conrad", weddingDate the 19th.
  "18/04 Red marker for 18th Glamp nusa wedding" → location "Glamp Nusa", weddingDate the 18th.
  "ribbons for weddings (20 raffles, 29 lombok wedding)" → two events: 20th Raffles, 29th Lombok.
  Treat a hotel/villa/resort/estate name (optionally followed by the word "wedding") as the location.
- DAY-ONLY / ORDINAL wedding dates: "19th", "18th", "1 may", "29 lombok", "for the 20th".
  Combine the day with the nearest month from context (often the same month as, or just after,
  the invoice date). If you cannot tell the month confidently, output the day you DID read and set
  a lower confidence; never invent a month silently.
Known venues: ${VENUES.join(', ')}. Known staff: ${STAFF.join(', ')}.

PIC vs BUYER (two different people):
- pic = the WEDDING's person-in-charge. Output EXACTLY one canonical value: LING, JAY,
  CHRISTI, PUTRI, or GENERAL. Found after the dash in "(Location-PIC)", or as "ling's", etc.
  NORMALIZE loose spellings staff actually use:
    • jessica / jesicca / jesicha / earvin → JAY
    • christy / christie / christi / andrian → CHRISTI
    • putri / radityasari → PUTRI
  May be absent — that's fine. Use GENERAL for non-wedding/studio/office.
- buyer = who PAID for it (to be reimbursed) = the HANDLER. Appears near "by <name>", "tf <name>",
  "<name> TRF/trf", or as a trailing name (putu, Minggu, putri, rania…). "TRF"/"tf" = bank transfer.

DESCRIPTION: the literal item/purpose words ("jahit kain", "Taper Candles", "gosend kyea",
"lace for welcome sign"). Never translate or invent a vendor name.

MULTIPLE EXPENSES IN ONE MESSAGE: a single message may list SEVERAL separate expenses, one
per line, each with its own amount (e.g. several "Gosend ... 20.000 ..." lines). Return one
array element per distinct expense. BUT items joined by commas within a single purchase
(e.g. "anggur merah, anggur hijau, anggur hitam + ongkir 4.050.000") are ONE expense.

Never invent values; use null if absent. Give an honest confidence 0..1.`;
}

const INSTRUCTION = `Parse the message into one or more expenses. Respond with ONLY this JSON:
{
  "expenses": [
    {
      "category": "wedding" | "shop" | "general",
      "isWedding": boolean,
      "invoiceDate": string | null,    // ISO, the FIRST date
      "weddingDate": string | null,    // ISO, the SECOND date (event)
      "pic": string | null,
      "organiser": string | null,
      "location": string | null,
      "buyer": string | null,
      "description": string | null,
      "amount": number | null,
      "confidence": number,
      "notes": string | null
    }
  ]
}`;

function toNote(parsed: any, rawText: string): WeddingNote {
  const category = ['wedding', 'shop', 'general'].includes(parsed?.category)
    ? (parsed.category as WeddingNote['category'])
    : 'wedding';
  return {
    category,
    isWedding: category === 'wedding' || Boolean(parsed?.isWedding),
    invoiceDate: str(parsed?.invoiceDate),
    weddingDate: str(parsed?.weddingDate),
    pic: str(parsed?.pic),
    organiser: str(parsed?.organiser),
    location: str(parsed?.location),
    buyer: str(parsed?.buyer),
    description: str(parsed?.description),
    amount: num(parsed?.amount),
    rawText,
    confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.5,
    notes: str(parsed?.notes),
  };
}

/** Parse a note that may contain several expenses. Returns at least one. */
export async function parseEmployeeNotes(rawText: string): Promise<WeddingNote[]> {
  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystem(),
    messages: [{ role: 'user', content: `${INSTRUCTION}\n\nMessage:\n"""${rawText}"""` }],
  });

  const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
  const parsed = safeParse(text);
  const list = Array.isArray(parsed?.expenses) ? parsed!.expenses : [];
  if (list.length === 0) {
    logger.warn({ text }, 'message parser returned no expenses');
    return [emptyNote(rawText)];
  }
  return list.map((e: any) => toNote(e, rawText));
}

/** Convenience: parse and return the first expense only. */
export async function parseEmployeeNote(rawText: string): Promise<WeddingNote> {
  return (await parseEmployeeNotes(rawText))[0] ?? emptyNote(rawText);
}

function emptyNote(rawText: string): WeddingNote {
  return {
    category: 'general', isWedding: false, invoiceDate: null, weddingDate: null, pic: null,
    organiser: null, location: null, buyer: null, description: null, amount: null,
    rawText, confidence: 0, notes: 'could not parse',
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
