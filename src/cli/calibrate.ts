/**
 * Calibration harness: run the FULL pipeline (parse → merge → enrich → block
 * check) over a real exported _chat.txt and report accuracy + failure modes,
 * so we can tune the parser prompt / venue / alias lists. Read-only, local.
 *   npx tsx src/cli/calibrate.ts "<path to _chat.txt>" [limit]
 */
import fs from 'node:fs';
import '../bootstrap.js';
import { parseEmployeeNotes } from '../agents/messageParser.js';
import { mergeToDraft } from '../expense.js';
import { enrichDraft, missingRequired } from '../schedule/enrich.js';
import { formatMoney } from '../util/money.js';

const file = process.argv[2] ?? 'chattingandindividualinvoice/WhatsApp Chat - DADA - Financial Report Group/_chat.txt';
const limit = Number(process.argv[3] ?? '90');

function extractNotes(raw: string): { sender: string; text: string }[] {
  const out: { sender: string; text: string }[] = [];
  const lineRe = /^‎?\[[^\]]+\]\s*(?:~\s*)?([^:]+):\s*(.*)$/;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const sender = m[1].trim();
    const text = m[2].replace(/‎?<附件：[^>]+>/g, '').replace(/‎?<attached:[^>]+>/gi, '').trim();
    if (!text) continue;
    if (sender.includes('Financial Report Group')) continue;
    if (/^(No sale|Reimbursement|Terimakasih|Total pembelian|Lihat tanda|Kalau gosend|Ne notane|This message|‎|image omitted|sticker omitted)/i.test(text)) continue;
    if (/^https?:\/\//.test(text)) continue;
    if (!/\d{3,}|\d{1,2}\s*[\/.]\s*\d{1,2}/.test(text)) continue; // has amount or date
    out.push({ sender, text });
  }
  return out;
}

async function main() {
  if (!fs.existsSync(file)) { console.error('not found:', file); process.exit(1); }
  const where = process.argv[4] ?? 'tail'; // 'tail' = newest, 'head' = oldest
  let notes = extractNotes(fs.readFileSync(file, 'utf8'));
  const total = notes.length;
  notes = where === 'head' ? notes.slice(0, limit) : notes.slice(-limit);
  console.log(`Found ${total} expense-looking notes; calibrating on ${notes.length} (${where} = ${where === 'tail' ? 'newest' : 'oldest'}).\n`);

  let drafts = 0, blocked = 0, lowConf = 0, filledDate = 0, filledPic = 0, weddings = 0, nonWed = 0;
  const blockedEx: string[] = [];
  const lowConfEx: string[] = [];

  for (const n of notes) {
    let parsed;
    try { parsed = await parseEmployeeNotes(n.text); }
    catch (e: any) { console.log(`parse error on "${n.text}": ${e.message ?? e}`); continue; }
    for (const note of parsed) {
      const d = mergeToDraft(note, null, null);
      const before = { date: d.weddingDate, pic: d.pic };
      enrichDraft(d);
      drafts++;
      if (d.isWedding) weddings++; else nonWed++;
      if (d.isWedding && !before.date && d.weddingDate) filledDate++;
      if (d.isWedding && !before.pic && d.pic) filledPic++;
      const miss = missingRequired(d);
      if (miss.length) { blocked++; if (blockedEx.length < 18) blockedEx.push(`[${n.sender}] ${n.text}  →  missing ${miss.join('+')} (loc=${d.location ?? '—'})`); }
      if (d.confidence < 0.5) { lowConf++; if (lowConfEx.length < 12) lowConfEx.push(`[${n.sender}] ${n.text}  →  ${d.vendorDescription ?? '—'} ${formatMoney(d.cost)} conf=${d.confidence}`); }
    }
  }

  console.log('═══════════ SUMMARY ═══════════');
  console.log(`drafts: ${drafts}  | weddings: ${weddings}  non-wedding: ${nonWed}`);
  console.log(`auto-filled wedding DATE from schedule/context: ${filledDate}`);
  console.log(`auto-filled PIC from schedule/context:          ${filledPic}`);
  console.log(`BLOCKED (still missing date or PIC): ${blocked}  (${((blocked / drafts) * 100).toFixed(0)}%)`);
  console.log(`low confidence (<0.5): ${lowConf}`);
  console.log('\n─────── BLOCKED examples (where the bot still needs staff input) ───────');
  blockedEx.forEach((e) => console.log('  • ' + e));
  console.log('\n─────── LOW-CONFIDENCE examples (parser unsure) ───────');
  lowConfEx.forEach((e) => console.log('  • ' + e));
}

main().catch((e) => console.error('error:', e.message ?? e));
