/* Automated WCAG 2.2 AA text-contrast check for both themes and every colour convention. */
import { contrastRatio } from '../src/lib/contrast';
import { contrastPairs, conventions, nonTextPairs, themes, type ThemeName } from '../src/tokens';

const MIN = 4.5;
let failures = 0;
const rows: string[] = [];
for (const name of Object.keys(themes) as ThemeName[]) {
  const t = themes[name];
  for (const [fg, bg, use] of contrastPairs(t)) {
    const r = contrastRatio(t[fg], t[bg]);
    const ok = r >= MIN;
    if (!ok) failures++;
    rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(13)} ${r.toFixed(2).padStart(6)}:1  ${t[fg]} on ${t[bg]}  (${use})`);
  }
  for (const [conv, c] of Object.entries(conventions[name])) {
    for (const surface of ['bg', 'panel', 'raised'] as const) {
      for (const [dir, colour] of [['up', c.up], ['down', c.down]] as const) {
        const r = contrastRatio(colour, t[surface]);
        const ok = r >= MIN;
        if (!ok) failures++;
        rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(13)} ${r.toFixed(2).padStart(6)}:1  ${colour} on ${t[surface]}  (${conv} ${dir} on ${surface})`);
      }
    }
    // IRTC R5-15: direction text on its own convention surface (selected option, depth bar label).
    for (const [dir, fg, bg] of [['up', c.up, c.upSurface], ['down', c.down, c.downSurface], ['text on up', t.text, c.upSurface], ['text on down', t.text, c.downSurface]] as const) {
      const r = contrastRatio(fg, bg);
      const ok = r >= MIN;
      if (!ok) failures++;
      rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(13)} ${r.toFixed(2).padStart(6)}:1  ${fg} on ${bg}  (${conv} ${dir} surface)`);
    }
  }
  // IRTC R5-16: non-text contrast (3:1) for graphics that carry meaning.
  for (const [fg, bg, use] of nonTextPairs()) {
    const r = contrastRatio(t[fg], t[bg]);
    const ok = r >= 3;
    if (!ok) failures++;
    rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(13)} ${r.toFixed(2).padStart(6)}:1  ${t[fg]} on ${t[bg]}  (${use}, non-text 3:1)`);
  }
}
console.log(rows.join('\n'));
console.log(`\n${rows.length - failures}/${rows.length} pairs meet ${MIN}:1`);
if (failures > 0) {
  console.error(`${failures} contrast failure(s)`);
  process.exit(1);
}
