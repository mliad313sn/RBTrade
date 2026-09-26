// Fills empty dev-only secrets in .env (never committed). Values are single-quoted for bash + Node.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? '.env';
let env = readFileSync(file, 'utf8');
const generators = {
  KORA_MFA_ENC_KEY: () => randomBytes(32).toString('base64'),
  KORA_DEV_IDP_PRIVATE_JWK: () => {
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    return JSON.stringify({ ...jwk, kid: `kora-dev-${Date.now()}` });
  },
};
for (const [name, gen] of Object.entries(generators)) {
  const re = new RegExp(`^${name}=\\s*$`, 'm');
  if (re.test(env)) {
    env = env.replace(re, () => `${name}='${gen()}'`);
    console.log(`[dev-db] generated ${name} in ${file}`);
  }
}
writeFileSync(file, env);
