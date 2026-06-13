import { fetch as undiciFetch, ProxyAgent } from 'undici';

const ports = [7890, 7897, 10809, 10808, 1087, 2080, 7891, 1080, 8889, 8080, 8888];

async function main() {
  console.log('probing local proxy ports…');
  for (const p of ports) {
    const url = `http://127.0.0.1:${p}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await undiciFetch('https://ipinfo.io/json', {
        dispatcher: new ProxyAgent(url),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const j = (await r.json()) as { country?: string; org?: string };
      console.log(`✅ port ${p} -> country=${j.country} org=${(j.org ?? '').slice(0, 30)}`);
    } catch (e: any) {
      console.log(`   port ${p} -> ${e?.cause?.code ?? e?.message ?? 'closed'}`);
    }
  }
  console.log('DONE — use the ✅ port as http://127.0.0.1:<port>');
}

main();
