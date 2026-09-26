import { KoraClient } from '@kora/sdk';

/** Browser client: same-origin /api proxy, HttpOnly cookie session, CSRF header added by the SDK. */
export const api = new KoraClient({ baseUrl: '/api' });
