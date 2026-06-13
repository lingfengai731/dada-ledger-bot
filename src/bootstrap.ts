/**
 * Proxy support. MUST be imported before any module that makes network calls.
 *
 * Node.js does NOT use the system/OS proxy by default. In regions where the
 * Anthropic API is geo-blocked (e.g. mainland China), the bot connects directly
 * and gets 403 "Request not allowed" even though your browser/VPN works fine.
 *
 * Set PROXY_URL (or HTTPS_PROXY) in .env to route the Anthropic SDK through your
 * local proxy. On an overseas server, leave it blank — traffic goes direct.
 *
 * We use undici's OWN fetch + ProxyAgent (not Node's built-in fetch), because
 * Node's global fetch rejects a dispatcher created by the npm `undici` package
 * (UND_ERR_INVALID_ARG, version mismatch). The SDK accepts a custom `fetch`.
 */
import 'dotenv/config';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

export const proxyUrl =
  process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || '';

const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

/** A fetch bound to the proxy, or undefined when no proxy is configured. */
export const proxyFetch = agent
  ? ((input: any, init?: any) => undiciFetch(input, { ...init, dispatcher: agent }))
  : undefined;

if (proxyUrl) {
  // eslint-disable-next-line no-console
  console.log(`[proxy] Anthropic API will route through ${proxyUrl}`);
}
