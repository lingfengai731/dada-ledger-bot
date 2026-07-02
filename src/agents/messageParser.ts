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

TEAM STANDARD FORMAT (the agreed template — trust it). The line STARTS with the invoice date:
   <invoice date>  <type>  <amount>  <item>  by <who paid>
   where <type> is one of:   wed <wedding date> pic <name>   |   shop   |   gen
   e.g. "15/6 wed 16/6 pic christi 1.500.000 bunga mitir by putu"   (wedding)
        "15/6 shop 250.000 vase stock by rania"                     (shop)
        "15/6 gen 80.000 office snacks by putu"                     (general)
- The FIRST date is the invoiceDate → set it. (A receipt photo's printed date still overrides.)
- "wed <date>" EXPLICITLY marks the WEDDING/event date → weddingDate; "pic <name>" marks the
  person-in-charge → pic. Both are AUTHORITATIVE — never second-guess them from position.
- "shop" → category "shop"; "gen" or "general" → category "general" (no weddingDate/pic for these).
- ITEM comes BEFORE the payer. "by <name>" (also tf/trf) at the END = the buyer/handler.
- The END may instead be "for ling payment" / "to be paid by ling": that is a PAYMENT FLAG
  (Ling pays the bill herself), NOT a buyer and NOT part of the item — do not put it in
  "buyer" or "description". Parse the rest of the line normally.

TWO AMOUNTS in ONE expense (not separate expenses): when a single purchase line has
two numbers, the "amount" is the INVOICE / grand total — usually the LARGER one. A smaller
second number is almost always the delivery fee (gosend / grab / ongkir) or a deposit ("DP"):
do NOT use it as the amount — record it in "notes" instead.
  • "0617 kyea 6.252.000 300.000 potato head trf ling" → amount 6252000 (invoice total);
    notes "300.000 likely gosend/ongkir". NOT 300000, NOT 6552000.
  • "bunga 1.500.000 + ongkir 50.000" → amount 1550000 only if the note clearly means a
    combined total; otherwise amount 1500000 and note the 50.000 ongkir.
The amount the staff TYPED is the source of truth — an attached receipt photo is only a
cross-check (invoices carry many numbers: fees, subtotals, VAT).

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
- "general": clearly NOT a wedding — markers include a leading "gen" or "general", "(General)",
  "studio", "office", "Reimbursement", "for stocks". Leave weddingDate null.
- "shop": for the retail shop — markers include a leading "shop", "for shop", "shop=", "Wish for shop". weddingDate null.
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
  IMPORTANT: a name in a "by/tf/trf <name>" phrase is the BUYER/handler, NOT the pic —
  never set pic from it. (e.g. "trf ling" → buyer "ling", pic stays null.)
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
    // A burst of ~15 expenses serialises to ~3.5k tokens; 2048 truncated the JSON
    // mid-object and the whole batch was lost. Give plenty of head-room.
    max_tokens: 8192,
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
    // The model's JSON was cut off (e.g. token limit) → the final object is
    // incomplete and JSON.parse fails on the whole thing. Rather than drop the
    // entire batch, salvage every COMPLETE expense object we can read.
    const salvaged = salvageExpenses(cleaned);
    return salvaged.length ? { expenses: salvaged } : null;
  }
}

/** Recover the complete `{...}` elements of the "expenses" array from a string
 *  whose tail was truncated. Walks the array tracking string/brace state and
 *  keeps each top-level object that parses on its own. */
function salvageExpenses(text: string): unknown[] {
  const arrStart = text.indexOf('[', text.indexOf('"expenses"'));
  if (arrStart === -1) return [];
  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }
  return out;
}
