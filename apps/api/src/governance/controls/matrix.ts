import { renderXlsx } from '../export/xlsx';
import { AREA_LABELS, CONTROL_AREAS, CONTROLS, type ControlDefinition } from './catalogue';

const LINE_LABEL = { 1: '1st line', 2: '2nd line', 3: '3rd line' } as const;

const esc = (s: string) => s.replace(/\|/g, '\\|');

/** Markdown control matrix, generated from the catalogue (do not edit the output by hand). */
export function renderMatrixMarkdown(controls: ControlDefinition[] = CONTROLS): string {
  const out: string[] = [];
  out.push('# KORA control matrix');
  out.push('');
  out.push(
    '> Generated from `apps/api/src/governance/controls/catalogue.ts` by `pnpm --filter @kora/api control-matrix` ' +
      '(also writes `control-matrix.xlsx`). Do not edit by hand: a unit test fails when this file and the catalogue differ.',
  );
  out.push('');
  out.push(
    'Goal 09 control framework aligned with COBIT 2019 (governance and management objectives) and ITIL 4 ' +
      '(incident management), with the Three Lines of Defence reflected in roles and tooling. Every control names an ' +
      '**automated evidence source that is implemented**: `GET /governance/controls/{id}/evidence?from&to&format=json|csv|pdf` ' +
      '(roles risk_officer, auditor, admin; audited as `governance.evidence_exported`) and the risk console export button produce it for any period.',
  );
  out.push('');
  out.push(
    '- **Owner line:** 1st line = the business and technology teams that run the process (trader, quant, engineering, operations); ' +
      '2nd line = risk and compliance (`risk_officer`); 3rd line = internal audit (`auditor`, read-only).',
  );
  out.push(
    '- **COBIT 2019 references** are a mapping aid, not a certification claim; the 2nd line confirms them against the licensed publication (OQ-G1).',
  );
  out.push(
    '- **No regulatory values** appear here. Figures such as retention periods, loss limits and disclosure percentages stay placeholders owned in `docs/open-questions.md`.',
  );
  out.push('');
  out.push('## Coverage');
  out.push('');
  out.push('| Area | Controls |');
  out.push('|---|---|');
  for (const a of CONTROL_AREAS) {
    const ids = controls.filter((c) => c.area === a).map((c) => c.id);
    out.push(`| ${AREA_LABELS[a]} | ${ids.join(', ') || '—'} |`);
  }
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| ID | Control | COBIT 2019 | Owner line | Frequency | Nature | Evidence |');
  out.push('|---|---|---|---|---|---|---|');
  for (const c of controls) {
    out.push(
      `| ${c.id} | ${esc(c.title)} | ${c.cobit.join(', ')} | ${LINE_LABEL[c.ownerLine]} | ${c.frequency} | ${c.nature}, ${c.automation} | ${c.evidence.kind} |`,
    );
  }
  out.push('');
  out.push('## Controls');
  for (const a of CONTROL_AREAS) {
    const list = controls.filter((c) => c.area === a);
    if (!list.length) continue;
    out.push('');
    out.push(`### ${AREA_LABELS[a]}`);
    for (const c of list) {
      out.push('');
      out.push(`#### ${c.id} — ${c.title}`);
      out.push('');
      out.push(`| Field | Value |`);
      out.push('|---|---|');
      out.push(`| Objective | ${esc(c.objective)} |`);
      out.push(`| COBIT 2019 | ${c.cobit.join(', ')} |`);
      out.push(`| Risk addressed | ${esc(c.risk)} |`);
      out.push(`| Owner | ${LINE_LABEL[c.ownerLine]}: ${esc(c.owner)} |`);
      out.push(`| Frequency | ${c.frequency} |`);
      out.push(`| Nature | ${c.nature}, ${c.automation} |`);
      out.push(`| Automated evidence (${c.evidence.kind}) | ${esc(c.evidence.source)} |`);
      out.push(
        `| Evidence export | \`GET /governance/controls/${c.id}/evidence?from=…&to=…&format=csv\\|pdf\` |`,
      );
      out.push(
        `| Sampling audit actions | ${c.auditActions.length ? c.auditActions.map((x) => `\`${x}\``).join(', ') : '— (population is the evidence table)'} |`,
      );
      out.push('');
      out.push('Test procedure:');
      out.push('');
      c.testProcedure.forEach((t, i) => out.push(`${i + 1}. ${t}`));
    }
  }
  out.push('');
  return out.join('\n');
}

export function renderMatrixXlsx(controls: ControlDefinition[] = CONTROLS): Buffer {
  return renderXlsx([
    {
      name: 'Control matrix',
      columns: [
        { header: 'ID', width: 8 },
        { header: 'Area', width: 20 },
        { header: 'Control', width: 34 },
        { header: 'Objective', width: 48 },
        { header: 'COBIT 2019', width: 16 },
        { header: 'Risk addressed', width: 40 },
        { header: 'Owner line', width: 10 },
        { header: 'Owner', width: 28 },
        { header: 'Frequency', width: 12 },
        { header: 'Nature', width: 12 },
        { header: 'Automation', width: 14 },
        { header: 'Evidence kind', width: 10 },
        { header: 'Automated evidence source', width: 52 },
        { header: 'Evidence export', width: 40 },
        { header: 'Test procedure', width: 70 },
        { header: 'Sampling audit actions', width: 36 },
      ],
      rows: controls.map((c) => [
        c.id,
        AREA_LABELS[c.area],
        c.title,
        c.objective,
        c.cobit.join(', '),
        c.risk,
        LINE_LABEL[c.ownerLine],
        c.owner,
        c.frequency,
        c.nature,
        c.automation,
        c.evidence.kind,
        c.evidence.source,
        `GET /governance/controls/${c.id}/evidence?from=&to=&format=csv|pdf`,
        c.testProcedure.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        c.auditActions.join(', '),
      ]),
    },
    {
      name: 'Coverage',
      columns: [
        { header: 'Area', width: 34 },
        { header: 'Controls', width: 40 },
        { header: 'Count', width: 8 },
      ],
      rows: CONTROL_AREAS.map((a) => {
        const ids = controls.filter((c) => c.area === a).map((c) => c.id);
        return [AREA_LABELS[a], ids.join(', '), ids.length];
      }),
    },
    {
      name: 'Legend',
      columns: [
        { header: 'Term', width: 24 },
        { header: 'Meaning', width: 100 },
      ],
      rows: [
        [
          '1st line',
          'Business and technology teams that run the process (trader, quant, engineering, operations).',
        ],
        ['2nd line', 'Risk and compliance (role risk_officer): console, approvals, oversight.'],
        [
          '3rd line',
          'Internal audit (role auditor): read-only audit log, chain verification, sampling, export.',
        ],
        [
          'COBIT 2019',
          'Mapping aid, not a certification claim; confirmed by the 2nd line against the licensed publication (OQ-G1).',
        ],
        [
          'Evidence export',
          'GET /governance/controls/{id}/evidence?from&to&format=json|csv|pdf (risk_officer, auditor, admin); audited.',
        ],
        [
          'Source of truth',
          'apps/api/src/governance/controls/catalogue.ts; generated by pnpm --filter @kora/api control-matrix.',
        ],
        ['Regulatory values', 'None here. Placeholders are owned in docs/open-questions.md.'],
      ],
    },
  ]);
}
