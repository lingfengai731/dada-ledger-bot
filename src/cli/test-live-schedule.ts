/** Verify the LIVE wedding-schedule read from Notion, then a komaneka lookup. */
import '../bootstrap.js';
import { refreshFromNotion, isLive, scheduleLoaded, lookupSchedule } from '../schedule/weddingSchedule.js';

async function main() {
  const ok = await refreshFromNotion();
  console.log(`refreshFromNotion -> ${ok}; isLive=${isLive()}; loaded=${scheduleLoaded()}`);
  const m = lookupSchedule({ venueText: 'komaneka', invoiceDate: '2026-06-15' });
  console.log('komaneka lookup:', m ? `${m.weddingDate} pic=${m.pic} venue="${m.venue}" client="${m.client}" via=${m.via} conf=${m.confidence}` : 'NONE');
}
main().catch((e) => console.error('error:', e.message ?? e));
