/**
 * Offline test of the wedding-schedule enrichment (no API / WhatsApp needed).
 *   npx tsx src/cli/eval-schedule.ts
 */
import '../bootstrap.js';
import { mergeToDraft } from '../expense.js';
import { enrichDraft, missingRequired, displayWeddingDate, displayPic } from '../schedule/enrich.js';
import { scheduleLoaded } from '../schedule/weddingSchedule.js';
import type { WeddingNote } from '../types.js';

function note(p: Partial<WeddingNote>): WeddingNote {
  return {
    category: 'wedding', isWedding: false, invoiceDate: null, weddingDate: null, pic: null,
    organiser: null, location: null, buyer: null, description: null, amount: null,
    rawText: '', confidence: 0.8, notes: null, ...p,
  };
}

const cases: { title: string; note: WeddingNote }[] = [
  {
    title: 'Komaneka receipt (the failing case): "06/15 mitir 06/15 1.000.000 putu (komaneka)"',
    note: note({ category: 'general', invoiceDate: '2026-06-15', description: 'Bunga mitir', amount: 1_000_000, buyer: 'putu', location: 'komaneka' }),
  },
  {
    title: 'Pandawa, no wedding date, PIC LTE-ish: "(pandawa)" on 2026-06-10',
    note: note({ invoiceDate: '2026-06-10', description: 'flowers', amount: 500_000, location: 'pandawa' }),
  },
  {
    title: 'Samabe Nusa Dua late June',
    note: note({ invoiceDate: '2026-06-20', description: 'decor', amount: 750_000, location: 'samabe' }),
  },
  {
    title: 'Non-wedding (General) — should NOT block',
    note: note({ category: 'general', invoiceDate: '2026-06-15', description: 'office electricity', amount: 300_000 }),
  },
  {
    title: 'Wedding with no venue & no date — should stay ??? and block',
    note: note({ category: 'wedding', isWedding: true, invoiceDate: '2026-06-15', description: 'misc', amount: 100_000 }),
  },
];

console.log('schedule loaded:', scheduleLoaded(), '\n');
for (const c of cases) {
  const d = mergeToDraft(c.note, null, null);
  enrichDraft(d);
  const miss = missingRequired(d);
  console.log('▶', c.title);
  console.log(`   wedding=${d.isWedding}  date=${displayWeddingDate(d)}  pic=${displayPic(d)}  invoice=${d.invoiceDate}  handler=${d.handler ?? '—'}`);
  if (d.info.length) console.log('   filled: ' + d.info.join(' | '));
  console.log('   ' + (miss.length ? `🚫 BLOCKED (missing: ${miss.join(', ')})` : '✅ OK to save'));
  console.log('');
}
