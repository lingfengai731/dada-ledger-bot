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

  -- Confirmed expense submissions (the records that go to Notion EXPENSES).
  CREATE TABLE IF NOT EXISTS expenses (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_message_id      TEXT,
    submitter          TEXT,
    vendor_description TEXT,
    wedding_date       TEXT,        -- ISO or null
    invoice_date       TEXT,
    cost               INTEGER,     -- whole Rupiah
    pic                TEXT,
    handler            TEXT,
    is_wedding         INTEGER NOT NULL DEFAULT 0,
    image_path         TEXT,
    raw_note           TEXT,
    notion_page_id     TEXT,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_wdate ON expenses(wedding_date);
  CREATE INDEX IF NOT EXISTS idx_expenses_pic ON expenses(pic);

  -- Learned mapping from a WhatsApp sender id to a known DADA person, so the bot
  -- recognises who posted a bill even when their display name is unusual. Grows as
  -- staff post (auto) or set it themselves with /iam (manual, never auto-overwritten).
  CREATE TABLE IF NOT EXISTS staff_map (
    wa_id      TEXT PRIMARY KEY,
    person     TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
    updated_at INTEGER NOT NULL
  );

  -- Drafts awaiting an "ok". Persisted so they survive a restart and so a sweep
  -- can auto-save the ones nobody replied to after a grace period.
  CREATE TABLE IF NOT EXISTS pending_drafts (
    sender        TEXT PRIMARY KEY,   -- one open draft set per submitter
    chat_id       TEXT NOT NULL,      -- where to post the auto-save / reminder
    wa_message_id TEXT,
    payload_json  TEXT NOT NULL,      -- the serialized Pending (drafts, notes, ...)
    updated_at    INTEGER NOT NULL,   -- last shown/corrected; the 8h clock runs from here
    reminded      INTEGER NOT NULL DEFAULT 0
  );
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

  // ---- expenses (confirmed submissions) ----

  insertExpense(e: {
    waMessageId: string | null;
    submitter: string;
    vendorDescription: string | null;
    weddingDate: string | null;
    invoiceDate: string | null;
    cost: number | null;
    pic: string | null;
    handler: string | null;
    isWedding: boolean;
    imagePath: string | null;
    rawNote: string;
    notionPageId: string | null;
  }): number {
    const info = db
      .prepare(
        `INSERT INTO expenses
          (wa_message_id, submitter, vendor_description, wedding_date, invoice_date,
           cost, pic, handler, is_wedding, image_path, raw_note, notion_page_id, created_at)
         VALUES (@wa, @submitter, @vendor, @wdate, @idate, @cost, @pic, @handler,
                 @isw, @img, @note, @notion, @created)`,
      )
      .run({
        wa: e.waMessageId,
        submitter: e.submitter,
        vendor: e.vendorDescription,
        wdate: e.weddingDate,
        idate: e.invoiceDate,
        cost: e.cost,
        pic: e.pic,
        handler: e.handler,
        isw: e.isWedding ? 1 : 0,
        img: e.imagePath,
        note: e.rawNote,
        notion: e.notionPageId,
        created: Date.now(),
      });
    return Number(info.lastInsertRowid);
  },

  /**
   * Find a previously-saved expense that looks like a duplicate of this one
   * (same amount + same invoice date + same description). Used to warn before
   * double-recording a re-posted receipt.
   */
  findDuplicateExpense(e: {
    cost: number | null;
    invoiceDate: string | null;
    vendorDescription: string | null;
  }): { id: number; vendor_description: string; created_at: number } | null {
    if (e.cost == null || !e.invoiceDate || !e.vendorDescription) return null;
    const row = db
      .prepare(
        `SELECT id, vendor_description, created_at FROM expenses
         WHERE cost = @cost AND invoice_date = @idate
           AND LOWER(TRIM(vendor_description)) = LOWER(TRIM(@vendor))
         ORDER BY id DESC LIMIT 1`,
      )
      .get({ cost: e.cost, idate: e.invoiceDate, vendor: e.vendorDescription });
    return (row as any) ?? null;
  },

  /** Total recorded per handler (who paid) — a rough reimbursement view. */
  owedByHandler(filters: { handler?: string; from?: string; to?: string }): {
    handler: string;
    total: number;
    count: number;
  }[] {
    const where: string[] = ['handler IS NOT NULL', "TRIM(handler) <> ''"];
    const params: Record<string, unknown> = {};
    if (filters.handler) {
      where.push('UPPER(handler) LIKE @h');
      params.h = `%${filters.handler.toUpperCase()}%`;
    }
    if (filters.from) {
      where.push('COALESCE(invoice_date, wedding_date) >= @from');
      params.from = filters.from;
    }
    if (filters.to) {
      where.push('COALESCE(invoice_date, wedding_date) <= @to');
      params.to = filters.to;
    }
    return db
      .prepare(
        `SELECT handler, COALESCE(SUM(cost),0) AS total, COUNT(*) AS count
         FROM expenses WHERE ${where.join(' AND ')}
         GROUP BY UPPER(handler) ORDER BY total DESC`,
      )
      .all(params) as { handler: string; total: number; count: number }[];
  },

  /** The most recent expense this submitter saved (for /undo). */
  getLastExpense(submitter: string): {
    id: number;
    vendor_description: string | null;
    cost: number | null;
    notion_page_id: string | null;
    created_at: number;
  } | null {
    const row = db
      .prepare(
        `SELECT id, vendor_description, cost, notion_page_id, created_at
         FROM expenses WHERE submitter = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(submitter);
    return (row as any) ?? null;
  },

  /** Delete a stored expense row (after its Notion page is archived). */
  removeExpense(id: number): void {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  },

  /** Total recorded per PIC over a period (by invoice/wedding date). */
  sumByPic(filters: { from?: string; to?: string }): { pic: string; total: number; count: number }[] {
    const where: string[] = ['pic IS NOT NULL', "TRIM(pic) <> ''"];
    const params: Record<string, unknown> = {};
    if (filters.from) { where.push('COALESCE(invoice_date, wedding_date) >= @from'); params.from = filters.from; }
    if (filters.to) { where.push('COALESCE(invoice_date, wedding_date) <= @to'); params.to = filters.to; }
    return db
      .prepare(
        `SELECT pic, COALESCE(SUM(cost),0) AS total, COUNT(*) AS count
         FROM expenses WHERE ${where.join(' AND ')} GROUP BY UPPER(pic) ORDER BY total DESC`,
      )
      .all(params) as { pic: string; total: number; count: number }[];
  },

  /** Period total + count by invoice/wedding date (for summaries). */
  periodTotal(filters: { from?: string; to?: string }): { total: number; count: number } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.from) { where.push('COALESCE(invoice_date, wedding_date) >= @from'); params.from = filters.from; }
    if (filters.to) { where.push('COALESCE(invoice_date, wedding_date) <= @to'); params.to = filters.to; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db
      .prepare(`SELECT COALESCE(SUM(cost),0) AS total, COUNT(*) AS count FROM expenses ${clause}`)
      .get(params) as { total: number; count: number };
  },

  /** Sum/list expenses with optional filters. Dates filter on wedding_date. */
  sumExpenses(filters: { from?: string; to?: string; pic?: string; isWedding?: boolean }): {
    total: number;
    count: number;
  } {
    const { clause, params } = buildExpenseWhere(filters);
    const row = db
      .prepare(`SELECT COALESCE(SUM(cost),0) AS total, COUNT(*) AS count FROM expenses ${clause}`)
      .get(params) as { total: number; count: number };
    return row;
  },

  listExpenses(filters: {
    from?: string;
    to?: string;
    pic?: string;
    isWedding?: boolean;
    limit?: number;
  }): any[] {
    const { clause, params } = buildExpenseWhere(filters);
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 30;
    return db
      .prepare(
        `SELECT id, vendor_description, wedding_date, invoice_date, cost, pic, handler, is_wedding
         FROM expenses ${clause} ORDER BY COALESCE(wedding_date, invoice_date) DESC, id DESC LIMIT ${limit}`,
      )
      .all(params);
  },

  // ---- staff map (sender id → known person) ----

  /** The known person we've learned for a WhatsApp sender id, or null. */
  getStaffPerson(waId: string): string | null {
    const row = db.prepare('SELECT person FROM staff_map WHERE wa_id = ?').get(waId) as { person: string } | undefined;
    return row?.person ?? null;
  },

  /** Learn/refresh a sender→person mapping. A 'manual' entry (set via /iam) is
   *  never overwritten by an 'auto' guess. Returns true if it changed. */
  setStaffPerson(waId: string, person: string, source: 'auto' | 'manual'): boolean {
    const cur = db.prepare('SELECT person, source FROM staff_map WHERE wa_id = ?').get(waId) as
      | { person: string; source: string }
      | undefined;
    if (cur && cur.source === 'manual' && source === 'auto') return false;
    if (cur && cur.person === person && cur.source === source) return false;
    db.prepare(
      `INSERT INTO staff_map (wa_id, person, source, updated_at) VALUES (@id, @p, @s, @t)
       ON CONFLICT(wa_id) DO UPDATE SET person=@p, source=@s, updated_at=@t`,
    ).run({ id: waId, p: person, s: source, t: Date.now() });
    return true;
  },

  // ---- pending drafts (awaiting "ok"; auto-saved after a grace period) ----

  /** Create/replace the open draft set for a submitter. */
  upsertPending(p: {
    sender: string;
    chatId: string;
    waMessageId: string | null;
    payloadJson: string;
    updatedAt: number;
  }): void {
    db.prepare(
      `INSERT INTO pending_drafts (sender, chat_id, wa_message_id, payload_json, updated_at, reminded)
       VALUES (@sender, @chat, @wa, @payload, @updated, 0)
       ON CONFLICT(sender) DO UPDATE SET
         chat_id=@chat, wa_message_id=@wa, payload_json=@payload, updated_at=@updated, reminded=0`,
    ).run({ sender: p.sender, chat: p.chatId, wa: p.waMessageId, payload: p.payloadJson, updated: p.updatedAt });
  },

  deletePending(sender: string): void {
    db.prepare('DELETE FROM pending_drafts WHERE sender = ?').run(sender);
  },

  markPendingReminded(sender: string): void {
    db.prepare('UPDATE pending_drafts SET reminded = 1 WHERE sender = ?').run(sender);
  },

  /** All open drafts (used to restore the in-memory map on startup). */
  allPending(): { sender: string; chat_id: string; wa_message_id: string | null; payload_json: string; updated_at: number; reminded: number }[] {
    return db.prepare('SELECT * FROM pending_drafts').all() as any[];
  },

  /** Open drafts last touched before `cutoff` (epoch ms) — candidates for auto-save. */
  pendingOlderThan(cutoff: number): { sender: string; chat_id: string; wa_message_id: string | null; payload_json: string; updated_at: number; reminded: number }[] {
    return db.prepare('SELECT * FROM pending_drafts WHERE updated_at < ?').all(cutoff) as any[];
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

function buildExpenseWhere(filters: {
  from?: string;
  to?: string;
  pic?: string;
  isWedding?: boolean;
}): { clause: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.from) {
    where.push('wedding_date >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    where.push('wedding_date <= @to');
    params.to = filters.to;
  }
  if (filters.pic) {
    where.push('UPPER(pic) LIKE @pic');
    params.pic = `%${filters.pic.toUpperCase()}%`;
  }
  if (filters.isWedding !== undefined) {
    where.push('is_wedding = @isw');
    params.isw = filters.isWedding ? 1 : 0;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { clause, params };
}

export { db };
