import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import type { Receipt, StoredReceipt } from '../types.js';

fs.mkdirSync(config.paths.dataDir, { recursive: true });

const db = new Database(config.paths.dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (
    wa_message_id TEXT PRIMARY KEY,
    processed_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_message_id  TEXT NOT NULL,
    receipt_index  INTEGER NOT NULL DEFAULT 0,  -- nth receipt within one photo
    sender         TEXT NOT NULL,
    image_path     TEXT NOT NULL,
    vendor         TEXT,
    invoice_no     TEXT,
    date           TEXT,            -- ISO YYYY-MM-DD
    recipient      TEXT,
    total          INTEGER,         -- whole Rupiah
    currency       TEXT NOT NULL DEFAULT 'IDR',
    confidence     REAL NOT NULL DEFAULT 0,
    notes          TEXT,
    items_json     TEXT NOT NULL DEFAULT '[]',
    processed_at   INTEGER NOT NULL,
    notion_page_id TEXT,
    UNIQUE (wa_message_id, receipt_index)
  );

  CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
  CREATE INDEX IF NOT EXISTS idx_receipts_recipient ON receipts(recipient);
  CREATE INDEX IF NOT EXISTS idx_receipts_vendor ON receipts(vendor);
`);

export interface InsertReceiptInput {
  waMessageId: string;
  receiptIndex: number;
  sender: string;
  imagePath: string;
  receipt: Receipt;
}

function rowToStored(row: any): StoredReceipt {
  return {
    id: row.id,
    waMessageId: row.wa_message_id,
    sender: row.sender,
    imagePath: row.image_path,
    vendor: row.vendor,
    invoiceNo: row.invoice_no,
    date: row.date,
    recipient: row.recipient,
    total: row.total,
    currency: row.currency,
    confidence: row.confidence,
    notes: row.notes,
    items: JSON.parse(row.items_json),
    processedAt: row.processed_at,
    notionPageId: row.notion_page_id,
  };
}

export const store = {
  /** True if we already processed this WhatsApp message. */
  hasMessage(waMessageId: string): boolean {
    const row = db
      .prepare('SELECT 1 FROM processed_messages WHERE wa_message_id = ?')
      .get(waMessageId);
    return Boolean(row);
  },

  markMessageProcessed(waMessageId: string): void {
    db.prepare(
      'INSERT OR IGNORE INTO processed_messages (wa_message_id, processed_at) VALUES (?, ?)',
    ).run(waMessageId, Date.now());
  },

  insertReceipt(input: InsertReceiptInput): StoredReceipt {
    const { receipt } = input;
    const stmt = db.prepare(`
      INSERT INTO receipts
        (wa_message_id, receipt_index, sender, image_path, vendor, invoice_no, date,
         recipient, total, currency, confidence, notes, items_json, processed_at)
      VALUES
        (@wa_message_id, @receipt_index, @sender, @image_path, @vendor, @invoice_no, @date,
         @recipient, @total, @currency, @confidence, @notes, @items_json, @processed_at)
    `);
    const info = stmt.run({
      wa_message_id: input.waMessageId,
      receipt_index: input.receiptIndex,
      sender: input.sender,
      image_path: input.imagePath,
      vendor: receipt.vendor,
      invoice_no: receipt.invoiceNo,
      date: receipt.date,
      recipient: receipt.recipient,
      total: receipt.total,
      currency: receipt.currency,
      confidence: receipt.confidence,
      notes: receipt.notes,
      items_json: JSON.stringify(receipt.items),
      processed_at: Date.now(),
    });
    return this.getById(Number(info.lastInsertRowid))!;
  },

  getById(id: number): StoredReceipt | null {
    const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    return row ? rowToStored(row) : null;
  },

  setNotionPageId(id: number, notionPageId: string): void {
    db.prepare('UPDATE receipts SET notion_page_id = ? WHERE id = ?').run(
      notionPageId,
      id,
    );
  },

  /**
   * Flexible read used by the query agent. All filters optional.
   * `from`/`to` are inclusive ISO dates (YYYY-MM-DD).
   */
  queryReceipts(filters: {
    from?: string;
    to?: string;
    vendor?: string;
    recipient?: string;
    limit?: number;
  }): StoredReceipt[] {
    const { clause, params } = buildWhere(filters);
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 200;
    const rows = db
      .prepare(
        `SELECT * FROM receipts ${clause} ORDER BY date DESC, id DESC LIMIT ${limit}`,
      )
      .all(params);
    return rows.map(rowToStored);
  },

  /** Aggregate total + count for a filter set. */
  sumReceipts(filters: {
    from?: string;
    to?: string;
    vendor?: string;
    recipient?: string;
  }): { total: number; count: number } {
    const { clause, params } = buildWhere(filters);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count FROM receipts ${clause}`,
      )
      .get(params) as { total: number; count: number };
    return { total: row.total, count: row.count };
  },
};

function buildWhere(filters: {
  from?: string;
  to?: string;
  vendor?: string;
  recipient?: string;
}): { clause: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.from) {
    where.push('date >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    where.push('date <= @to');
    params.to = filters.to;
  }
  if (filters.vendor) {
    where.push('LOWER(vendor) LIKE @vendor');
    params.vendor = `%${filters.vendor.toLowerCase()}%`;
  }
  if (filters.recipient) {
    where.push('LOWER(recipient) LIKE @recipient');
    params.recipient = `%${filters.recipient.toLowerCase()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { clause, params };
}

export { db };
