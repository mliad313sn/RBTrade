// Dev-only secrets in .env (never committed). Values are single-quoted for bash + Node.
// Fills keys that are present but empty, and appends keys that are missing altogether, so an .env
// created before a secret existed (e.g. KORA_SERVICE_TOKEN, goal 06) picks it up on the next run.
// Existing non-empty values are never touched.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? '.env';
let env = existsSync(file) ? readFileSync(file, 'utf8') : '';
const generators = {
  KORA_MFA_ENC_KEY: () => randomBytes(32).toString('base64'),
  // Bot runner ↔ api service token (goal 06, B-301).
  KORA_SERVICE_TOKEN: () => randomBytes(32).toString('base64url'),
  KORA_DEV_IDP_PRIVATE_JWK: () => {
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    return JSON.stringify({ ...jwk, kid: `kora-dev-${Date.now()}` });
  },
};
const appended = [];
let changed = false;
for (const [name, gen] of Object.entries(generators)) {
  const empty = new RegExp(`^${name}=[ \\t]*(?:''|"")?[ \\t]*$`, 'm');
  if (empty.test(env)) {
    env = env.replace(empty, () => `${name}='${gen()}'`);
    changed = true;
    console.log(`[dev-db] generated ${name} in ${file}`);
  } else if (!new RegExp(`^${name}=`, 'm').test(env)) {
    appended.push(`${name}='${gen()}'`);
    console.log(`[dev-db] added missing ${name} to ${file}`);
  }
}
if (appended.length) {
  if (env.length && !env.endsWith('\n')) env += '\n';
  env += `\n# Added by scripts/gen-dev-secrets.mjs (dev-only secrets missing from this .env)\n${appended.join('\n')}\n`;
  changed = true;
}
if (changed) writeFileSync(file, env);
