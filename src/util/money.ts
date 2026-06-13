import { config } from '../config.js';

/** Format a whole-Rupiah amount the way the group writes it: 12.496.000 */
export function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  return new Intl.NumberFormat(config.locale, {
    maximumFractionDigits: 0,
  }).format(amount);
}

/** "12.496.000" / "Rp 12.496.000" -> 12496000. Handles dot thousands separators. */
export function parseMoney(text: string): number | null {
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return null;
  return Number.parseInt(digits, 10);
}
