import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { proxyFetch } from '../bootstrap.js';

/** Shared Anthropic client. Reads ANTHROPIC_API_KEY from config/env.
 *  Routes through PROXY_URL when set (needed where the API is geo-blocked). */
export const claude = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(proxyFetch ? { fetch: proxyFetch as unknown as typeof fetch } : {}),
});

/** The model every agent uses. A live binding: `resolveModel()` may update it at
 *  startup, and importers (which read `MODEL` at call time) pick up the new value. */
export let MODEL = config.anthropic.model === 'auto' || config.anthropic.model === 'latest'
  ? 'claude-opus-4-8' // safe default until resolveModel() runs
  : config.anthropic.model;

/** When ANTHROPIC_MODEL is `auto`/`latest` (or unset), ask the API for the model
 *  list and pick the NEWEST Opus, so the bot tracks the strongest model without a
 *  code change as Anthropic ships new ones. Any failure keeps the safe default.
 *  Call once at startup before the agents run. */
export async function resolveModel(): Promise<string> {
  const want = (config.anthropic.model || 'auto').trim().toLowerCase();
  if (want !== 'auto' && want !== 'latest') return MODEL; // pinned explicitly
  try {
    const res: any = await (claude as any).models.list({ limit: 100 });
    const models: any[] = res?.data ?? [];
    const opus = models.filter((m) => /opus/i.test(String(m.id)));
    const pool = (opus.length ? opus : models).slice();
    pool.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
    if (pool[0]?.id) MODEL = pool[0].id;
  } catch {
    /* keep the safe default */
  }
  return MODEL;
}
