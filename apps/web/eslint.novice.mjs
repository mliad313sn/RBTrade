/**
 * Goal 08 §9 and the master goal's "no gamification": no confetti, streaks or leaderboards in the
 * Novice view. Any import path or JSX element whose name contains one of these words is an error in
 * the novice routes and components, including the goal 07/07B components rendered there (the
 * novice copilot explainer and the "What's moving" card). Tested in src/lib/novice/novice.test.ts.
 *
 * IRTC R4-19: the master goal applies to every screen. The Pro app gets the same core words plus a
 * ban on push/notification nudges; the novice files additionally ban badges, trophies, achievements
 * and rewards (a Pro status badge such as a market-session badge is a data label, not a reward).
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
  // Goal 07 / 07B components rendered in the novice routes.
  'src/components/ai/ExplainThis.tsx',
  'src/components/intel/WhatsMovingCard.tsx',
];

const CORE_WORDS = 'confetti|streak|leaderboard|trophy|trophies|achievement|gamif|celebrat';
const NOVICE_WORDS = `${CORE_WORDS}|badge|reward`;
const MESSAGE =
  'No gamification in the Novice view: confetti, streaks, leaderboards, badges, trophies and rewards are forbidden (goal 08 §9).';
const PRO_MESSAGE =
  'No gamification on any KORA screen (master goal): confetti, streaks, leaderboards, trophies.';
const NUDGE_MESSAGE =
  'No push nudges to trade (master goal): browser notifications and push subscriptions are not used.';

const rules = (words, message) => [
  { selector: `JSXOpeningElement[name.name=/(${words})/i]`, message },
  { selector: `JSXOpeningElement[name.property.name=/(${words})/i]`, message },
  { selector: `ImportExpression[source.value=/(${words})/i]`, message },
  { selector: `CallExpression[callee.name=/(${words})/i]`, message },
];

const NUDGES = [
  { selector: "NewExpression[callee.name='Notification']", message: NUDGE_MESSAGE },
  {
    selector: "MemberExpression[object.name='Notification'][property.name='requestPermission']",
    message: NUDGE_MESSAGE,
  },
  { selector: "MemberExpression[property.name='pushManager']", message: NUDGE_MESSAGE },
];

/** Every app file (Pro included). */
export const noGamificationAnywhere = {
  files: ['src/**/*.ts', 'src/**/*.tsx'],
  ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  rules: {
    'no-restricted-imports': [
      'error',
      { patterns: [{ regex: `(${CORE_WORDS})`, caseSensitive: false, message: PRO_MESSAGE }] },
    ],
    'no-restricted-syntax': ['error', ...rules(CORE_WORDS, PRO_MESSAGE), ...NUDGES],
  },
};

/** The novice files: stricter word list (flat config: this later block wins for these files). */
export const noviceNoGamification = {
  files: NOVICE_FILES,
  rules: {
    'no-restricted-imports': [
      'error',
      { patterns: [{ regex: `(${NOVICE_WORDS})`, caseSensitive: false, message: MESSAGE }] },
    ],
    'no-restricted-syntax': ['error', ...rules(NOVICE_WORDS, MESSAGE), ...NUDGES],
  },
};
