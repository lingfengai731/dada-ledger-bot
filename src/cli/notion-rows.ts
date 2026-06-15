/**
 * Shows the two candidate EXPENSES data sources side by side (name, sample rows,
 * whether they look like the live ledger vs a copy) so we can pick the test copy.
 *   npx tsx src/cli/notion-rows.ts
 */
import '../bootstrap.js';
import { Client } from '@notionhq/client';
import { proxyFetch } from '../bootstrap.js';

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  ...(proxyFetch ? { fetch: proxyFetch as any } : {}),
});

const CANDIDATES = [
  { label: 'EXPENSES (no suffix — likely ORIGINAL)', id: '27925f1b-255a-80df-9bd0-000b7968e853' },
  { label: 'EXPENSES (1) (likely COPY/backup)', id: 'cec25f1b-255a-8390-b86b-076832d4f087' },
];

function plain(prop: any): string {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title ?? []).map((t: any) => t.plain_text).join('');
  if (prop.type === 'number') return prop.number == null ? '' : String(prop.number);
  if (prop.type === 'date') return prop.date?.start ?? '';
  return '';
}

async function main() {
  for (const c of CANDIDATES) {
    console.log('\n████████████████████████████████████████');
    console.log(c.label);
    console.log('data_source_id:', c.id);
    try {
      const res: any = await notion.dataSources.query({ data_source_id: c.id, page_size: 5 });
      console.log('sample rows (first 5), more pages:', res.has_more);
      for (const row of res.results as any[]) {
        const p = row.properties ?? {};
        const vendor = plain(p['VENDOR / DESCRIPTION']);
        const cost = plain(p['COST']);
        const wdate = plain(p['WEDDING DATE']);
        console.log(`   • ${vendor || '(no title)'} | COST ${cost} | wedding ${wdate} | created ${row.created_time}`);
      }
    } catch (e: any) {
      console.log('   query failed:', e.code ?? e.message);
    }
  }
}

main().catch((e) => console.error('error:', e.code ?? '', e.message ?? e));
