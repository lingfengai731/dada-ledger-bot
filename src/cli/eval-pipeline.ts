/**
 * End-to-end (parser + schedule enrichment) on raw note text.
 *   npx tsx src/cli/eval-pipeline.ts "06/15 mitir 06/15 1.000.000 putu ( komaneka)"
 */
import '../bootstrap.js';
import { parseEmployeeNotes } from '../agents/messageParser.js';
import { mergeToDraft } from '../expense.js';
import { enrichDraft, missingRequired, displayWeddingDate, displayPic } from '../schedule/enrich.js';
import { formatMoney } from '../util/money.js';

const raw = process.argv[2] ?? '06/15 mitir 06/15 1.000.000 putu ( komaneka)';

async function main() {
  const notes = await parseEmployeeNotes(raw);
  console.log(`RAW: ${raw}\n`);
  notes.forEach((n, i) => {
    const d = mergeToDraft(n, null, null);
    enrichDraft(d);
    const miss = missingRequired(d);
    console.log(`#${i + 1} parsed: cat=${n.category} loc=${n.location ?? '—'} pic=${n.pic ?? '—'} buyer=${n.buyer ?? '—'} inv=${n.invoiceDate ?? '—'} wed=${n.weddingDate ?? '—'}`);
    console.log(`   draft: ${d.vendorDescription} | ${formatMoney(d.cost)} | wedding=${d.isWedding} date=${displayWeddingDate(d)} pic=${displayPic(d)} handler=${d.handler ?? '—'}`);
    if (d.info.length) console.log('   filled: ' + d.info.join(' | '));
    console.log('   ' + (miss.length ? `🚫 BLOCKED (${miss.join(', ')})` : '✅ OK to save'));
    console.log('');
  });
}
main().catch((e) => console.error('error:', e.message ?? e));
