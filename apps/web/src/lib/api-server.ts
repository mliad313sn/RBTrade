import 'server-only';

import { KoraApiError, KoraClient, type MeResponse } from '@kora/sdk';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const API_INTERNAL_URL = () => process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

/** Server-side API client that forwards the session cookie as a bearer token. */
export async function serverClient(): Promise<KoraClient> {
  const token = (await cookies()).get('kora_at')?.value;
  return new KoraClient({ baseUrl: API_INTERNAL_URL(), token });
}

export async function requireMe(): Promise<MeResponse> {
  try {
    return await (await serverClient()).me();
  } catch (e) {
    if (e instanceof KoraApiError && (e.status === 401 || e.status === 403)) redirect('/login');
    throw e;
  }
}
