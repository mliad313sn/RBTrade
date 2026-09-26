import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bandFor, suitabilityBands } from '../compliance/suitability.service';
import { renderDisclosure, placeholderFor, DisclosureDefinitionSchema } from '../disclosures/disclosure-render';
import riskWarningV1 from '../disclosures/risk-warning.v1.json';
import { CONTROL_AREAS, CONTROLS } from './controls/catalogue';
import { EVIDENCE } from './controls/evidence-queries';
import { parseRange } from './controls/evidence.service';
import { renderMatrixMarkdown, renderMatrixXlsx } from './controls/matrix';
import { csvCell, toCsv } from './export/csv';
import { renderPdf, tableLines } from './export/pdf';
import { renderXlsx, unzip, zip } from './export/xlsx';
import { loadGovernanceConfig } from './governance-config';
import { RETENTION_CLASSES, retentionDays } from './retention';

const DOCS = resolve(__dirname, '../../../../docs/governance');

describe('control catalogue', () => {
  it('every control is complete, unique and has an implemented evidence query (and no query is orphaned)', () => {
    const ids = CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CONTROLS) {
      expect(c.id).toMatch(/^KC-\d{2}$/);
      expect(c.cobit.length, c.id).toBeGreaterThan(0);
      for (const ref of c.cobit) expect(ref, c.id).toMatch(/^(EDM|APO|BAI|DSS|MEA)\d{2}(\.\d{2})?$/);
      expect([1, 2, 3]).toContain(c.ownerLine);
      expect(c.objective.length).toBeGreaterThan(20);
      expect(c.risk.length).toBeGreaterThan(20);
      expect(c.evidence.source.length).toBeGreaterThan(10);
      expect(c.testProcedure.length).toBeGreaterThan(0);
      expect(typeof EVIDENCE[c.id], c.id).toBe('function');
    }
    expect(Object.keys(EVIDENCE).sort()).toEqual([...ids].sort());
  });

  it('covers every area goal 09 lists, and all three lines of defence', () => {
    for (const a of CONTROL_AREAS) expect(CONTROLS.some((c) => c.area === a), a).toBe(true);
    expect(new Set(CONTROLS.map((c) => c.ownerLine))).toEqual(new Set([1, 2, 3]));
    // Segregation of duties covers the three four-eyes cases the goal names.
    const sod = CONTROLS.filter((c) => c.area === 'segregation_of_duties').map((c) => c.title.toLowerCase()).join(' ');
    for (const w of ['promotion', 'loosening', 'resum']) expect(sod).toContain(w);
  });

  it('the committed control-matrix.md and .xlsx are generated from the catalogue (no drift)', () => {
    expect(readFileSync(resolve(DOCS, 'control-matrix.md'), 'utf8')).toBe(renderMatrixMarkdown());
    const committed = unzip(readFileSync(resolve(DOCS, 'control-matrix.xlsx')));
    const fresh = unzip(renderMatrixXlsx());
    expect([...committed.keys()].sort()).toEqual([...fresh.keys()].sort());
    for (const [k, v] of fresh) expect(committed.get(k), k).toBe(v);
  });
});

describe('export writers', () => {
  it('CSV quotes when needed and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(toCsv(['a', 'b'], [[1, 'x\ny']])).toBe('a,b\r\n1,"x\ny"\r\n');
  });

  it('PDF is well-formed: header, objects, xref offsets, trailer; long tables paginate', () => {
    const rows = Array.from({ length: 200 }, (_, i) => [i, `row ${i} (with parens) \\ and ünïcödé ≥ →`, true]);
    const pdf = renderPdf([{ text: 'Title', font: 'F2', size: 14 }, ...tableLines(['n', 'text', 'ok'], rows)], { title: 'T', footer: 'F' });
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const pages = Number(/\/Count (\d+)/.exec(s)![1]);
    expect(pages).toBeGreaterThan(1);
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    // Every xref offset points at "<n> 0 obj".
    const entries = s.slice(xref).split('\n').slice(3).filter((l) => /^\d{10} 00000 n $/.test(l));
    entries.forEach((e, i) => expect(s.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(s).toContain('\\(with parens\\)');
    expect(s).toContain('>=');
  });

  it('XLSX zips round-trip, escape XML and are deterministic', () => {
    const a = renderXlsx([{ name: 'S', columns: [{ header: 'A & B' }, { header: 'n' }], rows: [['<x>', 2], [null, true]] }]);
    const b = renderXlsx([{ name: 'S', columns: [{ header: 'A & B' }, { header: 'n' }], rows: [['<x>', 2], [null, true]] }]);
    expect(a.equals(b)).toBe(true);
    const files = unzip(a);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']));
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('A &amp; B');
    expect(sheet).toContain('&lt;x&gt;');
    expect(sheet).toContain('<v>2</v>');
    expect(sheet).toContain('t="b"><v>1</v>');
    expect(unzip(zip([{ name: 'a.txt', data: Buffer.from('hello') }])).get('a.txt')).toBe('hello');
  });

  it('the matrix workbook has the control sheet with every control and the required columns', () => {
    const sheet = unzip(renderMatrixXlsx()).get('xl/worksheets/sheet1.xml')!;
    for (const h of ['COBIT 2019', 'Owner line', 'Frequency', 'Automated evidence source', 'Test procedure']) expect(sheet).toContain(h);
    for (const c of CONTROLS) expect(sheet).toContain(`>${c.id}<`);
  });
});

describe('governance settings and helpers', () => {
  it('evidence periods: default 30 days, validated order and length', () => {
    const r = parseRange(undefined, '2026-09-26T00:00:00Z');
    expect(r.from.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    expect(() => parseRange('2026-09-27T00:00:00Z', '2026-09-26T00:00:00Z')).toThrow();
    expect(() => parseRange('2025-01-01T00:00:00Z', '2026-09-26T00:00:00Z')).toThrow();
    expect(() => parseRange('nope', undefined)).toThrow();
  });

  it('defaults are conservative; the anchor key is required outside dev/test', () => {
    const c = loadGovernanceConfig({});
    expect(c).toMatchObject({ resumePolicy: 'firm', nearPausePct: 70, nearLimitPct: 80, jurisdiction: 'GLOBAL', releaseRecord: true });
    expect(loadGovernanceConfig({ KORA_FOUR_EYES_RESUME: 'all' }).resumePolicy).toBe('all');
    expect(() => loadGovernanceConfig({ KORA_ENV: 'production' })).toThrow(/KORA_AUDIT_ANCHOR_JWK/);
    expect(() => loadGovernanceConfig({ KORA_JURISDICTION: 'france' })).toThrow();
  });

  it('retention: periods are placeholders unless Compliance sets them; market-data ticks keep 7 days', () => {
    const audit = RETENTION_CLASSES.find((c) => c.id === 'audit_events')!;
    expect(retentionDays(audit, {})).toBeNull();
    expect(retentionDays(audit, { KORA_RETENTION_AUDIT_EVENTS_DAYS: '2555' })).toBe(2555);
    expect(retentionDays(RETENTION_CLASSES.find((c) => c.id === 'md_trades')!, {})).toBe(7);
    for (const c of RETENTION_CLASSES) if (c.defaultDays === null) expect(c.openQuestion, c.id).toMatch(/^OQ-/);
  });

  it('suitability bands are SIMULATED placeholders with an env override', () => {
    expect(suitabilityBands({})).toEqual([34, 67]);
    expect(suitabilityBands({ KORA_SUITABILITY_BANDS: '40,80' })).toEqual([40, 80]);
    expect(suitabilityBands({ KORA_SUITABILITY_BANDS: '80,40' })).toEqual([34, 67]);
    expect(bandFor(10)).toBe('cautious');
    expect(bandFor(50)).toBe('balanced');
    expect(bandFor(90)).toBe('adventurous');
  });

  it('disclosure rendering is stable: same definition and values → same content hash; placeholders stay visible', () => {
    const def = DisclosureDefinitionSchema.parse(riskWarningV1);
    const a = renderDisclosure(def, 'en', {});
    expect(a.values.retailLossPct).toBe('[XX]');
    expect(a.placeholder).toBe(true);
    expect(a.banner).toContain('[XX]%');
    expect(renderDisclosure(def, 'en', { retailLossPct: '[XX]' }).contentHash).toBe(a.contentHash);
    const set = renderDisclosure(def, 'en', { retailLossPct: '74' });
    expect(set.placeholder).toBe(false);
    expect(set.contentHash).not.toBe(a.contentHash);
    expect(placeholderFor('other')).toBe('[other]');
  });
});
