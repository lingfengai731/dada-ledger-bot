import { store } from '../db/store.js';
import { formatMoney } from '../util/money.js';
import { config } from '../config.js';
import { baliTodayISO } from '../util/dates.js';

/** ISO date N days before today (Bali). */
function daysAgoISO(n: number): string {
  const today = new Date(`${baliTodayISO()}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - n);
  return today.toISOString().slice(0, 10);
}

/** Build a human-readable spend summary for the last `days` (default 7). */
export function buildPeriodSummary(days = 7): string {
  const from = daysAgoISO(days - 1);
  const to = baliTodayISO();
  const { total, count } = store.periodTotal({ from, to });
  const byPic = store.sumByPic({ from, to });
  const byHandler = store.owedByHandler({ from, to });

  const cur = config.currency;
  const lines: string[] = [
    `📊 *DADA spend summary* (${from} → ${to})`,
    `*Total:* ${formatMoney(total)} ${cur}  ·  ${count} expense${count === 1 ? '' : 's'}`,
  ];
  if (byPic.length) {
    lines.push('', '*By PIC (wedding lead):*');
    for (const r of byPic.slice(0, 8)) lines.push(`• ${r.pic}: ${formatMoney(r.total)} (${r.count})`);
  }
  if (byHandler.length) {
    lines.push('', '*Paid by (handler — to reimburse):*');
    for (const r of byHandler.slice(0, 8)) lines.push(`• ${r.handler}: ${formatMoney(r.total)} (${r.count})`);
    lines.push('_Note: totals recorded by the bot, not net of reimbursements._');
  }
  if (count === 0) lines.push('', '_No expenses recorded in this period._');
  return lines.join('\n');
}
