import { SELF_SERVICE_ROLES } from '@kora/domain';
import { z } from 'zod';

import { MIN_PASSWORD_LENGTH } from './password';

export const SignupSchema = z
  .object({
    email: z.email().max(320).transform((e) => e.toLowerCase()),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(256),
    displayName: z.string().trim().min(1).max(80),
    accountType: z.enum(SELF_SERVICE_ROLES as ['novice', 'trader']).default('novice'),
  })
  .strict();

export const LoginSchema = z
  .object({
    email: z.email().max(320),
    password: z.string().min(1).max(256),
  })
  .strict();

export const MfaEnrollSchema = z.object({ mfaToken: z.string().min(10).max(4096) }).strict();

export const MfaVerifySchema = z
  .object({
    mfaToken: z.string().min(10).max(4096),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();
