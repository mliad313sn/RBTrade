import './env';
import './tracing-bootstrap';

import { loadConfig } from './config/config';
import { createApp } from './create-app';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();
  await app.listen(config.port, process.env.API_HOST ?? '127.0.0.1');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
