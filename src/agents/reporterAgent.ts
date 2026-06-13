import { config } from '../config.js';
import type { StoredReceipt } from '../types.js';
import { formatMoney } from '../util/money.js';

/**
 * Build the WhatsApp message we post back into the group after reading a photo.
 * Mirrors the manual format the group already uses, plus a confirmed total.
 */
export function buildReceiptReport(receipts: StoredReceipt[]): string {
  if (receipts.length === 0) {
    return '⚠️ I couldn’t read a receipt in that image. Please resend a clearer photo.';
  }

  const lines: string[] = [];
  lines.push('🧾 *Receipt read automatically*');
  lines.push('');

  let grand = 0;
  let lowConfidence = false;

  receipts.forEach((r, idx) => {
    const header = [
      r.vendor ?? 'Receipt',
      r.invoiceNo ? `#${r.invoiceNo}` : null,
      r.date ? `(${r.date})` : null,
      r.recipient ? `→ ${r.recipient}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(receipts.length > 1 ? `*${idx + 1}. ${header}*` : `*${header}*`);

    for (const it of r.items) {
      const qty = it.quantity ? `${it.quantity}× ` : '';
      const amt = it.amount !== null ? formatMoney(it.amount) : '—';
      lines.push(`   • ${qty}${it.name}: ${amt}`);
    }

    if (r.total !== null) {
      grand += r.total;
      lines.push(`   _Subtotal: ${formatMoney(r.total)}_`);
    }
    if (r.confidence < 0.6) lowConfidence = true;
    lines.push('');
  });

  lines.push(`*TOTAL: ${formatMoney(grand)} ${config.currency}*`);

  if (lowConfidence) {
    lines.push('');
    lines.push('⚠️ _Some figures were hard to read — please double-check._');
  }
  if (config.dryRun) {
    lines.push('');
    lines.push('_(DRY_RUN preview — not actually posted to the group)_');
  }

  return lines.join('\n');
}
