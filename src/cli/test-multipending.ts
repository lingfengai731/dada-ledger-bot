import 'dotenv/config';
import { config } from '../config.js';
import { __test } from '../whatsapp/bot.js';
import type { WeddingNote } from '../types.js';

if (config.notion.writeMode === 'live' || !config.dryRun) {
  console.error('REFUSING TO RUN: not in preview/dry-run mode'); process.exit(2);
}
const sender = 'TESTER@c.us';
const msg = (id: string): any => ({ id: { _serialized: id }, from: 'G@g.us', author: sender, getContact: async () => ({ pushname: 'Putu' }), reply: async () => null });
const note = (desc: string, amt: number): WeddingNote => ({ category: 'general', isWedding: false, invoiceDate: '2026-06-20', weddingDate: null, pic: null, organiser: null, location: null, buyer: 'jay', description: desc, amount: amt, rawText: '', confidence: 0.9, notes: null });

async function main() {
  for (const p of __test.pendingsForSender(sender)) __test.pendingDrafts.delete(p.id);

  // Two SEPARATE submissions must NOT merge.
  await __test.finalize(msg('m1'), sender, [note('breakfast', 59000)], null, null, []);
  await __test.finalize(msg('m2'), sender, [note('arya bill', 350000)], null, null, []);
  const ps = __test.pendingsForSender(sender);
  const separate = ps.length === 2 && ps.every((p) => p.drafts.length === 1);
  console.log('two separate submissions -> pendings:', ps.length, '| each single:', ps.every(p=>p.drafts.length===1), '=>', separate ? 'OK' : 'FAIL');

  // A burst (one submission, 3 notes) -> ONE pending with 3 drafts.
  await __test.finalize(msg('m3'), sender, [note('a', 1000), note('b', 2000), note('c', 3000)], null, null, []);
  const burst = __test.pendingsForSender(sender).find((p) => p.id === 'm3')!;
  const burstOk = __test.pendingsForSender(sender).length === 3 && burst.drafts.length === 3;
  console.log('burst -> one pending,', burst.drafts.length, 'drafts; total pendings now 3 =>', burstOk ? 'OK' : 'FAIL');

  // Bare "ok" commits ALL outstanding for the sender.
  await __test.commitPendings(msg('ok'), __test.pendingsForSender(sender));
  const left = __test.pendingsForSender(sender).length;
  console.log('bare ok -> pendings left:', left, '=>', left === 0 ? 'OK' : 'FAIL');

  // No TOTAL in a group multi-summary (commitPendings/renderSummary).
  console.log('\nRESULT:', separate && burstOk && left === 0 ? '✅ PASS — separate, not merged; burst grouped; ok-all clears' : '❌ FAIL');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
