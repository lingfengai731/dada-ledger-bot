/** Today as ISO YYYY-MM-DD in local time. */
export function todayISO(): string {
  return toISO(new Date());
}

/** IANA zone for Bali / Central Indonesia time (WITA, UTC+8). */
export const BALI_TZ = 'Asia/Makassar';

/** Today in Bali (WITA) as ISO YYYY-MM-DD — the staff's "now", regardless of server location. */
export function baliTodayISO(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BALI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Bali wall-clock parts for scheduling: date, hour (0-23), weekday (Sun=0…Sat=6), day-of-month. */
export function baliParts(): { date: string; hour: number; weekday: number; dayOfMonth: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BALI_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wk: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    weekday: wk[get('weekday')] ?? -1,
    dayOfMonth: Number(get('day')),
  };
}

/** Human-readable Bali wall-clock, e.g. "Thursday, 18 June 2026, 11:24". */
export function baliNowText(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BALI_TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

/** Whole days between two ISO dates (b - a). Returns null if either is unparseable. */
export function daysBetween(aISO: string | null, bISO: string | null): number | null {
  if (!aISO || !bISO) return null;
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Parse a Chinese-formatted Notion date like "2026年6月16日" (or a range "A → B") to ISO start date. */
export function parseChineseDate(text: string): { start: string; end: string | null } | null {
  const re = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const y = m[1];
    const mo = String(Number(m[2])).padStart(2, '0');
    const d = String(Number(m[3])).padStart(2, '0');
    found.push(`${y}-${mo}-${d}`);
  }
  if (found.length === 0) return null;
  return { start: found[0], end: found[1] ?? null };
}

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** First and last day (ISO) of the month that `ref` falls in. */
export function monthRange(ref: Date = new Date()): { from: string; to: string } {
  const from = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const to = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  return { from: toISO(from), to: toISO(to) };
}
