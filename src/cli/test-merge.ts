/** Offline check of the kyea / Potato Head / TO CHRISTI scenario (no API). */
import '../bootstrap.js';
import { mergeToDraft } from '../expense.js';
import { enrichDraft } from '../schedule/enrich.js';
import type { WeddingNote, Receipt } from '../types.js';

// What the parser SHOULD now produce: "trf ling" → buyer only, pic null.
const note: WeddingNote = {
  category: 'wedding', isWedding: true, invoiceDate: '2026-06-17', weddingDate: null,
  pic: null, organiser: null, location: 'potato head', buyer: 'ling',
  description: 'potatoes head', amount: 6_252_000, rawText: '0617 kyea ... trf ling',
  confidence: 0.9, notes: null,
};
// The PDF: issued by KYEA, addressed TO CHRISTI.
const receipt: Receipt = {
  vendor: 'kyea', invoiceNo: null, date: '2026-06-17', recipient: 'CHRISTI',
  items: [], total: 6_252_000, currency: 'IDR', confidence: 0.95, notes: null,
};

const d = mergeToDraft(note, receipt, null, 'Some Tester'); // sender doesn't match staff
enrichDraft(d);
console.log('vendorDescription:', d.vendorDescription, '   (want: kyea, potatoes head)');
console.log('handler          :', d.handler, '   (want: CHRISTI — from "TO CHRISTI")');
console.log('pic              :', d.pic, '   (want: CHRISTI — schedule, since trf-ling is not pic)');
console.log('weddingDate      :', d.weddingDate, '   (want: 2026-06-21)');
console.log('cost             :', d.cost);
