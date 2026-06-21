import 'dotenv/config';
import { parseEmployeeNotes } from '../agents/messageParser.js';
import { mergeToDraft } from '../expense.js';

const BURST = `06/19 breakfast 06/19 130,000 putu ( soori)
06/19 dinner 06/19 240,000 putu( soori)
06/20 breakfast 06/20 100,000 putu( arnalaya)
06/20 lunch 06/20 360,000 putu ( arnalaya)
06/20 dinner 06/20 160,000 putu
06/19 gosend 06/19 168,000 putu ( soori)
06/20 gosend 06/20 70,000 putu ( arnalaya)
06/20 anggur 06/21 300,000 putu ( potato)
06/20 cat silver 06/20 216,000 putu ( arnalaya)
06/20 platik,tissu,tusuk sate 06/20 196,000 putu ( arnalaya)
06/20 snack 06/21 268,000 putu ( soori)
06/20 seng alumunium 06/20 204,000 putu ( arnalaya)
06/20 kertas & platik 2kg 06/20 118,000 putu( arnalaya)
06/20 snack 06/20 59,000 putu( arnalaya)
2106 2206 samabe 990.000 putri table cloth`;

async function main() {
  const t0 = Date.now();
  const notes = await parseEmployeeNotes(BURST);
  console.log(`Parsed ${notes.length} expenses in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  let total = 0;
  notes.forEach((n, i) => {
    const d = mergeToDraft(n, null, null, null);
    total += d.cost ?? 0;
    console.log(
      `${String(i + 1).padStart(2)}. ${(d.vendorDescription ?? '?').padEnd(28)} ` +
      `${String(d.cost ?? '?').padStart(9)}  inv ${d.invoiceDate ?? '—'}  wed ${d.weddingDate ?? '—'}  ` +
      `pic ${d.pic ?? '—'}  by ${d.handler ?? '—'}  loc ${n.location ?? '—'}` +
      (n.notes ? `  [note: ${n.notes}]` : ''),
    );
  });
  console.log(`\nExpected 15 lines. Got ${notes.length}. TOTAL ${total.toLocaleString('id-ID')}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
