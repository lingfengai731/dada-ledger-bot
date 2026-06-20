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

/** Epoch ms of Bali (WITA, UTC+8) midnight for today — start of "today". */
function baliMidnightMs(): number {
  return new Date(`${baliTodayISO()}T00:00:00+08:00`).getTime();
}

/**
 * Itemized list of everything the bot saved TODAY — DM'd to the boss each night
 * so she can review the day in one message instead of watching the group.
 */
export function buildDailyDigest(): string {
  const rows = store.expensesCreatedSince(baliMidnightMs());
  const cur = config.currency;
  const head = `📒 *DADA — today's ledger* (${baliTodayISO()})`;
  if (!rows.length) return `${head}\n_No expenses recorded today._`;

  const lines: string[] = [head, `${rows.length} expense${rows.length === 1 ? '' : 's'} saved today:`, ''];
  let total = 0;
  rows.forEach((r, i) => {
    total += r.cost ?? 0;
    const tag = r.is_wedding ? `wed ${r.wedding_date ?? '—'} · ${r.pic ?? '—'}` : 'non-wedding';
    const who = r.handler ? ` · ${r.handler} paid` : '';
    lines.push(`*${i + 1}.* ${r.vendor_description ?? '—'} — ${formatMoney(r.cost)} _(${tag}${who})_`);
  });
  lines.push('', `*Total today: ${formatMoney(total)} ${cur}*`);
  return lines.join('\n');
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
