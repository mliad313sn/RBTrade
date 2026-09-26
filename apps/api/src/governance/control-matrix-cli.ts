import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMatrixMarkdown, renderMatrixXlsx } from './controls/matrix';

/** Writes docs/governance/control-matrix.md and .xlsx from the control catalogue (goal 09). */
const dir = resolve(__dirname, '../../../../docs/governance');
writeFileSync(resolve(dir, 'control-matrix.md'), renderMatrixMarkdown());
writeFileSync(resolve(dir, 'control-matrix.xlsx'), renderMatrixXlsx());
console.log(`[control-matrix] wrote ${dir}/control-matrix.md and control-matrix.xlsx`);
