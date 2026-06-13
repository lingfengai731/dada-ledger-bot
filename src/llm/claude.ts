import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { proxyFetch } from '../bootstrap.js';

/** Shared Anthropic client. Reads ANTHROPIC_API_KEY from config/env.
 *  Routes through PROXY_URL when set (needed where the API is geo-blocked). */
export const claude = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(proxyFetch ? { fetch: proxyFetch as unknown as typeof fetch } : {}),
});

export const MODEL = config.anthropic.model;
