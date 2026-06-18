/** Verify live PIC/HANDLER option sync from the EXPENSES data source (preview, no write). */
import '../bootstrap.js';
import { writeExpense } from '../notion/expenses.js';
import type { ExpenseDraft } from '../expense.js';

const draft: ExpenseDraft = {
  vendorDescription: 'TEST ONLY — do not save', weddingDate: '2026-06-16', invoiceDate: '2026-06-15',
  cost: 1000, pic: 'christi', handler: 'rania', location: 'komaneka', isWedding: true,
  confidence: 1, warnings: [], info: [], imagePath: null, rawNote: 'test',
};

async function main() {
  const r = await writeExpense(draft); // preview mode → builds props, does not write
  console.log('written:', r.written, '(should be false in preview)');
  console.log('PIC prop:', JSON.stringify((r.properties as any)['PIC']));
  console.log('HANDLER prop:', JSON.stringify((r.properties as any)['HANDLER']));
  console.log('unmapped:', r.unmapped);
}
main().catch((e) => console.error('error:', e.message ?? e));
