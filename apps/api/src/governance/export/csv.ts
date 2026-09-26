export type CsvCell = string | number | boolean | null | undefined;

/**
 * RFC 4180 CSV with CSV-injection neutralisation (OWASP): a cell that starts with = + - @ tab or CR
 * is prefixed with a single quote so spreadsheet tools never evaluate it. Numbers are written as-is.
 */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: CsvCell[][]): string {
  return [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
