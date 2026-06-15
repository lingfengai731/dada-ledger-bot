import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL } from '../llm/claude.js';
import { store } from '../db/store.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { formatMoney } from '../util/money.js';
import { todayISO } from '../util/dates.js';

const tools: Anthropic.Tool[] = [
  {
    name: 'sum_expenses',
    description:
      'Sum total spend and count expenses, optionally filtered by WEDDING DATE range, ' +
      'PIC (person in charge), or wedding vs non-wedding. Use for "how much did we spend" ' +
      'questions. Dates are ISO YYYY-MM-DD, inclusive, and filter on the wedding date.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Wedding date from YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'Wedding date to YYYY-MM-DD (inclusive)' },
        pic: { type: 'string', description: 'PIC name, e.g. "JAY", "CHRISTI"' },
        isWedding: { type: 'boolean', description: 'true = only wedding expenses, false = only non-wedding' },
      },
    },
  },
  {
    name: 'list_expenses',
    description:
      'List individual expenses (vendor/description, wedding date, cost, PIC, handler) ' +
      'matching filters. Use for "which expenses" / "show me" questions.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Wedding date from YYYY-MM-DD' },
        to: { type: 'string', description: 'Wedding date to YYYY-MM-DD' },
        pic: { type: 'string' },
        isWedding: { type: 'boolean' },
        limit: { type: 'integer', description: 'Max rows (default 30)' },
      },
    },
  },
];

function runTool(name: string, input: any): unknown {
  if (name === 'sum_expenses') {
    const { total, count } = store.sumExpenses(input ?? {});
    return { total, count, formattedTotal: formatMoney(total), currency: config.currency };
  }
  if (name === 'list_expenses') {
    const rows = store.listExpenses({ ...(input ?? {}), limit: input?.limit ?? 30 });
    return rows.map((r: any) => ({
      id: r.id,
      vendorDescription: r.vendor_description,
      weddingDate: r.wedding_date,
      invoiceDate: r.invoice_date,
      pic: r.pic,
      handler: r.handler,
      isWedding: Boolean(r.is_wedding),
      cost: r.cost,
      formattedCost: formatMoney(r.cost),
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
