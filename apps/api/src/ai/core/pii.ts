import { createHash } from 'node:crypto';

/**
 * PII minimisation for prompts: the model never sees e-mail addresses, names, phone numbers, account
 * or card numbers. Users are referred to by a pseudonymous reference (salted hash, not reversible
 * without the salt), which is enough to keep a conversation coherent.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?:\+|00)\d[\d\s().-]{7,16}\d/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function redactPii(text: string, opts: { keepUuids?: boolean } = {}): string {
  let out = text
    .replace(EMAIL, '[email]')
    .replace(IBAN, '[account]')
    .replace(CARD, '[number]')
    .replace(PHONE, '[phone]');
  if (!opts.keepUuids) out = out.replace(UUID, '[id]');
  return out;
}

export function pseudonym(
  userId: string,
  salt = process.env.KORA_AI_PSEUDONYM_SALT ?? 'kora-ai',
): string {
  return `u_${createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 10)}`;
}

/** Keys that must never be sent to the model inside tool outputs or context. */
export const PII_KEYS = new Set([
  'email',
  'displayName',
  'display_name',
  'name_of_user',
  'ownerEmail',
  'owner_id',
  'ownerId',
  'userId',
  'user_id',
  'accountId',
  'account_id',
  'authorId',
  'author_id',
  'ip',
  'phone',
]);

export function stripPiiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPiiKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !PII_KEYS.has(k))
        .map(([k, v]) => [k, stripPiiKeys(v)]),
    );
  }
  return value;
}
