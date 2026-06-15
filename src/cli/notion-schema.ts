/**
 * Discovers the real Notion schema (2025-09-03 data-sources API).
 *   npx tsx src/cli/notion-schema.ts
 */
import '../bootstrap.js';
import { Client } from '@notionhq/client';
import { proxyFetch } from '../bootstrap.js';

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  ...(proxyFetch ? { fetch: proxyFetch as any } : {}),
});

function titleOf(obj: any): string {
  if (Array.isArray(obj.title)) return obj.title.map((t: any) => t.plain_text).join('');
  return obj.name ?? '(untitled)';
}

async function main() {
  // 1. Collect distinct parent database ids from accessible pages + any database objects.
  const dbIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const res: any = await notion.search({ page_size: 100, start_cursor: cursor });
    for (const r of res.results as any[]) {
      if (r.object === 'database') dbIds.add(r.id);
      const par = r.parent ?? {};
      if (par.database_id) dbIds.add(par.database_id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && dbIds.size < 20);

  // 2. For each database, list its data sources, then read each data source schema.
  for (const dbId of dbIds) {
    try {
      const db: any = await notion.databases.retrieve({ database_id: dbId });
      const sources: any[] = db.data_sources ?? [];
      console.log('\n████████████████████████████████████████');
      console.log(`DATABASE: ${titleOf(db)}  (db id ${dbId})`);
      console.log(`data sources: ${sources.map((s) => s.name).join(', ') || '(none)'}`);
      for (const s of sources) {
        const ds: any = await notion.dataSources.retrieve({ data_source_id: s.id });
        console.log(`\n  ── data source "${ds.name ?? s.name}"  (id ${s.id})`);
        for (const [name, p] of Object.entries<any>(ds.properties ?? {})) {
          let extra = '';
          if (['select', 'status', 'multi_select'].includes(p.type)) {
            extra = ` → [${(p[p.type]?.options ?? []).map((o: any) => o.name).join(', ')}]`;
          }
          console.log(`       • ${name}  (${p.type})${extra}`);
        }
      }
    } catch (e: any) {
      console.log(`(skip ${dbId}: ${e.code ?? e.message})`);
    }
  }
}

main().catch((e) => console.error('error:', e.code ?? '', e.message ?? e));
