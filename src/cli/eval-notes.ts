/**
 * Runs the message parser over a real exported WhatsApp _chat.txt and prints a
 * raw → parsed table, so we can eyeball accuracy. Reads private local data only.
 *   npx tsx src/cli/eval-notes.ts "WhatsApp Chat - DADA - Financial Report Group/_chat.txt"
 */
import fs from 'node:fs';
import '../bootstrap.js';
import { parseEmployeeNote } from '../agents/messageParser.js';
import { formatMoney } from '../util/money.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npx tsx src/cli/eval-notes.ts <path to _chat.txt>');
  process.exit(1);
}

// Pull the human text out of each WhatsApp line, dropping system msgs & attachments.
function extractNotes(raw: string): { sender: string; text: string }[] {
  const out: { sender: string; text: string }[] = [];
  const lineRe = /^‎?\[[^\]]+\]\s*(?:~\s*)?([^:]+):\s*(.*)$/;
  for (let line of raw.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const sender = m[1].trim();
    let text = m[2].replace(/‎?<附件：[^>]+>/g, '').trim();
    if (!text) continue;
    if (sender.includes('Financial Report Group')) continue; // system
    if (/^(No sale|Reimbursement|Terimakasih|Total pembelian|Lihat tanda|Kalau gosend|Ne notane)/i.test(text)) continue;
    if (/^https?:\/\//.test(text)) continue;
    // expense-looking only: has an amount or a date
    if (!/\d{3,}|\d{1,2}\s*[\/.]\s*\d{1,2}/.test(text)) continue;
    out.push({ sender, text });
  }
  return out;
}

async function main() {
  const notes = extractNotes(fs.readFileSync(file, 'utf8'));
  console.log(`Parsing ${notes.length} expense notes…\n`);
  let i = 0;
  for (const n of notes) {
    i++;
    const r = await parseEmployeeNote(n.text);
    console.log(`#${i} [${n.sender}] ${n.text}`);
    console.log(
      `    → ${r.category.toUpperCase()} | ${r.description ?? '—'} | ${formatMoney(r.amount)} | ` +
        `inv ${r.invoiceDate ?? '—'} | wed ${r.weddingDate ?? '—'} | ` +
        `loc ${r.location ?? '—'} | pic ${r.pic ?? '—'} | buyer ${r.buyer ?? '—'} | conf ${r.confidence}`,
    );
    if (r.notes) console.log(`      note: ${r.notes}`);
    console.log('');
  }
}

main().catch((e) => console.error('error:', e.message ?? e));
