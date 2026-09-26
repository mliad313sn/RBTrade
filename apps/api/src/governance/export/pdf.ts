/**
 * Minimal dependency-free PDF 1.4 writer for evidence reports (goal 09): text only, standard fonts
 * (Helvetica, Helvetica-Bold, Courier), WinAnsi encoding, A4 landscape, automatic page breaks.
 * Characters outside Latin-1 are replaced with "?" (the CSV/JSON exports carry the exact text).
 */
export interface PdfLine {
  text: string;
  font?: 'F1' | 'F2' | 'F3';
  size?: number;
  /** Extra space before the line, in points. */
  gap?: number;
}

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 36;

function latin1(s: string): string {
  const map: Record<string, string> = { '\u2013': '-', '\u2014': '-', '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...', '\u2265': '>=', '\u2264': '<=', '\u2260': '!=', '\u2192': '->', '\u2022': '*', '\u2715': 'x', '\u25b2': '^', '\u25bc': 'v' };
  let out = '';
  for (const ch of s) {
    const m = map[ch];
    if (m !== undefined) out += m;
    else out += ch.charCodeAt(0) <= 0xff ? ch : '?';
  }
  return out;
}

function escape(s: string): string {
  return latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]/g, ' ');
}

/** Width of a Courier line in characters at a font size (Courier is 0.6 em). */
export function courierChars(size: number): number {
  return Math.floor((PAGE_W - 2 * MARGIN) / (0.6 * size));
}

export function renderPdf(lines: PdfLine[], meta: { title: string; footer: string }): Buffer {
  // Paginate.
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const l of lines) {
    const size = l.size ?? 9;
    const lead = size * 1.25 + (l.gap ?? 0);
    if (y - lead < MARGIN + 18) newPage();
    y -= lead;
    ops.push(`BT /${l.font ?? 'F1'} ${size} Tf ${MARGIN} ${y.toFixed(2)} Td (${escape(l.text)}) Tj ET`);
  }
  newPage();
  const n = pages.length;
  pages.forEach((p, i) => p.push(`BT /F1 7 Tf ${MARGIN} 20 Td (${escape(`${meta.footer} - page ${i + 1} of ${n}`)}) Tj ET`));

  // Objects: 1 catalog, 2 pages, 3-5 fonts, 6 info, then per page: page + content.
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${7 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  objs.push(`<< /Title (${escape(meta.title)}) /Producer (KORA evidence export) >>`);
  for (let i = 0; i < n; i++) {
    const content = pages[i]!.join('\n');
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${8 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  }
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Lays out a table as fixed-width Courier lines (columns truncated to fit the page). */
export function tableLines(columns: string[], rows: Array<Array<string | number | boolean | null>>, size = 7): PdfLine[] {
  const max = courierChars(size);
  const str = (v: string | number | boolean | null) => (v === null ? '' : String(v));
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => str(r[i] ?? null).length)));
  // Shrink the widest columns until the line fits.
  const total = () => widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 2;
  while (total() > max) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i]! <= 6) break;
    widths[i] = widths[i]! - 1;
  }
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c.length > widths[i]! ? `${c.slice(0, Math.max(1, widths[i]! - 1))}~` : c.padEnd(widths[i]!))).join('  ').slice(0, max);
  return [
    { text: fmt(columns), font: 'F3', size, gap: 4 },
    { text: widths.map((w) => '-'.repeat(w)).join('  ').slice(0, max), font: 'F3', size },
    ...rows.map((r) => ({ text: fmt(r.map(str)), font: 'F3' as const, size })),
  ];
}
