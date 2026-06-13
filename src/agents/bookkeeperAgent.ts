import { store } from '../db/store.js';
import { pushReceiptToNotion } from '../notion/notionClient.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Receipt, StoredReceipt } from '../types.js';

export interface BookkeepInput {
  waMessageId: string;
  sender: string;
  imagePath: string;
  receipts: Receipt[];
}

/** Persist every receipt from one photo to SQLite, then sync to Notion. */
export async function bookkeep(input: BookkeepInput): Promise<StoredReceipt[]> {
  const stored: StoredReceipt[] = [];

  for (let i = 0; i < input.receipts.length; i++) {
    const saved = store.insertReceipt({
      waMessageId: input.waMessageId,
      receiptIndex: i,
      sender: input.sender,
      imagePath: input.imagePath,
      receipt: input.receipts[i],
    });
    stored.push(saved);
  }

  if (config.notion.enabled) {
    for (const r of stored) {
      const pageId = await pushReceiptToNotion(r);
      if (pageId) {
        store.setNotionPageId(r.id, pageId);
        r.notionPageId = pageId;
      }
    }
  }

  store.markMessageProcessed(input.waMessageId);
  logger.info(
    { count: stored.length, notion: config.notion.enabled },
    'bookkeeper stored receipts',
  );
  return stored;
}
