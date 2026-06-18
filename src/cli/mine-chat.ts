/**
 * OFFLINE miner: scan a real _chat.txt with regex (NO API/token cost) to learn
 * staff habits — venues, vendors, handlers, aliases — so we can strengthen the
 * parser's known lists. Read-only, local.
 *   npx tsx src/cli/mine-chat.ts "<_chat.txt>"
 */
import fs from 'node:fs';

const file = process.argv[2] ?? 'chattingandindividualinvoice/WhatsApp Chat - DADA - Financial Report Group/_chat.txt';
const raw = fs.readFileSync(file, 'utf8');
const lineRe = /^‎?\[[^\]]+\]\s*(?:~\s*)?([^:]+):\s*(.*)$/;

const texts: string[] = [];
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(lineRe);
  if (!m) continue;
  const sender = m[1].trim();
  if (sender.includes('Financial Report Group')) continue;
  const t = m[2].replace(/‎?<[^>]+>/g, '').trim();
  if (t) texts.push(t);
}

const tally = (arr: string[]) => {
  const m = new Map<string, number>();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const show = (title: string, pairs: [string, number][], n = 25) => {
  console.log(`\n=== ${title} (top ${n}) ===`);
  for (const [k, v] of pairs.slice(0, n)) console.log(`${String(v).padStart(4)}  ${k}`);
};

// 1) parenthetical tokens — venues and (Venue-PIC) patterns
const parens: string[] = [];
for (const t of texts) for (const m of t.matchAll(/\(([^)]{2,40})\)/g)) parens.push(m[1].trim().toLowerCase());
show('parenthetical (venue / venue-pic)', tally(parens), 30);

// 2) handlers after by/tf/trf/cash
const handlers: string[] = [];
for (const t of texts) for (const m of t.matchAll(/\b(?:by|tf|trf|trf\.|transfer)\s+([a-zA-Z]{2,15})/gi)) handlers.push(m[1].toLowerCase());
show('handler after by/tf/trf', tally(handlers), 20);

// 3) UPPERCASE vendor names (2+ caps words)
const vendors: string[] = [];
for (const t of texts) for (const m of t.matchAll(/\b([A-Z][A-Z.]+(?:\s+[A-Z][A-Z.&]+){1,4})\b/g)) {
  const v = m[1].trim();
  if (v.length >= 6 && !/^(IDR|PT|CV|DADA|GOSEND|TRF)$/.test(v)) vendors.push(v);
}
show('UPPERCASE vendor-ish names', tally(vendors), 30);

// 4) date format split (dd/mm vs other)
let slashDates = 0, named = 0, fourDigit = 0;
for (const t of texts) {
  if (/\b\d{1,2}\s*[\/.]\s*\d{1,2}\b/.test(t)) slashDates++;
  if (/\b\d{1,2}\s*(jan|feb|mar|apr|may|mei|jun|jul|aug|agu|sep|oct|okt|nov|dec|des)/i.test(t)) named++;
  if (/\b\d{4}\b/.test(t.replace(/[.,]/g, ''))) fourDigit++;
}
console.log(`\n=== date styles ===\n slash(13/06): ${slashDates}\n month-name(13 jun): ${named}\n 4-digit(0616): ${fourDigit}`);
console.log(`\nTotal message lines scanned: ${texts.length}`);
