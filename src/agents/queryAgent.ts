import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL } from '../llm/claude.js';
import { store } from '../db/store.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { formatMoney } from '../util/money.js';
import { todayISO } from '../util/dates.js';

const tools: Anthropic.Tool[] = [
  {
    name: 'sum_receipts',
    description:
      'Sum the total spend and count receipts, optionally filtered by date range, ' +
      'vendor, or recipient. Use this for "how much did we spend" questions. ' +
      'Dates are ISO YYYY-MM-DD and inclusive.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
        vendor: { type: 'string', description: 'Vendor name substring, e.g. "Fuad"' },
        recipient: { type: 'string', description: 'Recipient substring, e.g. "DADA"' },
      },
    },
  },
  {
    name: 'list_receipts',
    description:
      'List individual receipts (vendor, invoice, date, recipient, total) matching ' +
      'filters. Use this for "which receipts" / "show me the receipts" questions.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
        vendor: { type: 'string' },
        recipient: { type: 'string' },
        limit: { type: 'integer', description: 'Max rows (default 20)' },
      },
    },
  },
];

function runTool(name: string, input: any): unknown {
  if (name === 'sum_receipts') {
    const { total, count } = store.sumReceipts(input ?? {});
    return { total, count, formattedTotal: formatMoney(total), currency: config.currency };
  }
  if (name === 'list_receipts') {
    const rows = store.queryReceipts({ ...(input ?? {}), limit: input?.limit ?? 20 });
    return rows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      invoiceNo: r.invoiceNo,
      date: r.date,
      recipient: r.recipient,
      total: r.total,
      formattedTotal: formatMoney(r.total),
    }));
  }
  return { error: `unknown tool ${name}` };
}

/**
 * Answer a free-text question about the ledger. The model is given DB tools and
 * loops until it produces a final natural-language answer.
 */
export async function answerQuestion(question: string): Promise<string> {
  const system = `You are the bookkeeping assistant for "DADA Island".
You answer questions about purchase receipts stored in a database, using the provided tools.
Today's date is ${todayISO()}. Currency is ${config.currency} (Indonesian Rupiah);
format amounts with "." thousands separators (e.g. 12.496.000).
Be concise and reply in the same language the user asked in (English or Chinese or Indonesian).
If there is no data for the requested period, say so plainly. Never invent numbers — only
report what the tools return.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: question },
  ];

  for (let step = 0; step < 6; step++) {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const out = runTool(block.name, block.input);
          logger.debug({ tool: block.name, input: block.input }, 'query agent tool call');
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(out),
          });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    // Final answer
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || '(no answer)';
  }

  return 'Sorry, I could not work that out. Please rephrase the question.';
}
