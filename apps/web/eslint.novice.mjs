/**
 * Goal 08 §9 and the master goal's "no gamification": no confetti, streaks or leaderboards in the
 * Novice view. Any import path or JSX element whose name contains one of these words is an error in
 * the novice routes and components. Tested in src/lib/novice/lint.test.ts.
 */
export const NOVICE_FILES = [
  'src/app/(app)/home/**',
  'src/app/(app)/practice/**',
  'src/app/(app)/auto-invest/**',
  'src/app/(app)/learn/**',
  'src/app/(app)/onboarding/**',
  'src/app/offline/**',
  'src/components/novice/**',
  'src/components/sim/Practice.tsx',
  'src/components/shell/NoviceShell.tsx',
  'src/lib/novice/**',
];

const WORDS = 'confetti|streak|leaderboard';
const MESSAGE =
  'No gamification in the Novice view: confetti, streaks and leaderboards are forbidden (goal 08 §9).';

export const noviceNoGamification = {
  files: NOVICE_FILES,
  rules: {
    'no-restricted-imports': [
      'error',
      { patterns: [{ regex: `(${WORDS})`, caseSensitive: false, message: MESSAGE }] },
    ],
    'no-restricted-syntax': [
      'error',
      { selector: `JSXOpeningElement[name.name=/(${WORDS})/i]`, message: MESSAGE },
      { selector: `JSXOpeningElement[name.property.name=/(${WORDS})/i]`, message: MESSAGE },
      { selector: `ImportExpression[source.value=/(${WORDS})/i]`, message: MESSAGE },
      { selector: `CallExpression[callee.name=/(${WORDS})/i]`, message: MESSAGE },
    ],
  },
};
