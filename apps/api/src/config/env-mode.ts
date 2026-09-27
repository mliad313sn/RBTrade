/**
 * IRTC R6-12: test aids and dev-only leniencies (the session override, the scripted and replay AI
 * providers, unsigned audit anchors, open metrics) need `KORA_ENV` set **explicitly** to `dev` or
 * `test`. An unset or misspelt `KORA_ENV` is treated as production (fail closed), and so is
 * `NODE_ENV=production` whatever `KORA_ENV` says.
 */
export function isExplicitDevOrTest(env: NodeJS.ProcessEnv): boolean {
  const k = env.KORA_ENV?.trim();
  return (k === 'dev' || k === 'test') && env.NODE_ENV !== 'production';
}
