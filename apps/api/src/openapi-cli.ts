import './env';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOpenApi, createApp } from './create-app';

async function main(): Promise<void> {
  const app = await createApp({ logger: false });
  const out = resolve(__dirname, '../../../packages/sdk/openapi.json');
  writeFileSync(out, `${JSON.stringify(buildOpenApi(app), null, 2)}\n`);
  await app.close();
  console.warn(`[openapi] wrote ${out}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
