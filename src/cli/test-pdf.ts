/** Test reading a PDF invoice through the vision agent. */
import fs from 'node:fs';
import '../bootstrap.js';
import { extractReceipts } from '../agents/visionAgent.js';

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('usage: tsx src/cli/test-pdf.ts <file.pdf>'); process.exit(1); }
  const b64 = fs.readFileSync(file).toString('base64');
  const receipts = await extractReceipts(b64, 'application/pdf');
  console.log(`receipts found: ${receipts.length}`);
  for (const r of receipts) {
    console.log(`  vendor=${r.vendor} invoiceNo=${r.invoiceNo} date=${r.date} total=${r.total} conf=${r.confidence}`);
    console.log(`  items: ${r.items.map((i) => `${i.quantity ?? ''}x ${i.name}=${i.amount}`).join(' | ')}`);
    if (r.notes) console.log(`  notes: ${r.notes}`);
  }
}
main().catch((e) => console.error('error:', e.message ?? e));
