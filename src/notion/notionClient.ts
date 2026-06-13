import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { StoredReceipt } from '../types.js';
import { formatMoney } from '../util/money.js';

/**
 * Expected Notion database columns (create these in your ledger database):
 *   - "Name"       (Title)
 *   - "Date"       (Date)
 *   - "Vendor"     (Text)
 *   - "Recipient"  (Text)
 *   - "Invoice"    (Text)
 *   - "Total"      (Number)
 *   - "Items"      (Text)
 *   - "Confidence" (Number)
 * Missing columns are skipped gracefully — only "Name" is strictly required.
 */

const notion = config.notion.enabled
  ? new Client({ auth: config.notion.apiKey })
  : null;

export async function pushReceiptToNotion(r: StoredReceipt): Promise<string | null> {
  if (!notion) return null;

  const title =
    [r.vendor, r.invoiceNo].filter(Boolean).join(' #') ||
    `Receipt ${r.id}`;

  const itemsText = r.items
    .map((it) => {
      const qty = it.quantity ? `${it.quantity}x ` : '';
      const amt = it.amount !== null ? ` = ${formatMoney(it.amount)}` : '';
      return `${qty}${it.name}${amt}`;
    })
    .join('\n');

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: title } }] },
  };
  if (r.date) properties.Date = { date: { start: r.date } };
  if (r.vendor) properties.Vendor = { rich_text: [{ text: { content: r.vendor } }] };
  if (r.recipient)
    properties.Recipient = { rich_text: [{ text: { content: r.recipient } }] };
  if (r.invoiceNo)
    properties.Invoice = { rich_text: [{ text: { content: r.invoiceNo } }] };
  if (r.total !== null) properties.Total = { number: r.total };
  if (itemsText) properties.Items = { rich_text: [{ text: { content: itemsText.slice(0, 1900) } }] };
  properties.Confidence = { number: Number(r.confidence.toFixed(2)) };

  try {
    const page = await notion.pages.create({
      parent: { database_id: config.notion.databaseId },
      properties: properties as any,
    });
    return page.id;
  } catch (err) {
    logger.error({ err }, 'Notion push failed — check DB id, sharing, and column names');
    return null;
  }
}
