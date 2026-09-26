import { z } from 'zod';

import { MIN_PASSWORD_LENGTH } from './password';

export const SignupSchema = z
  .object({
    email: z.email().max(320).transform((e) => e.toLowerCase()),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(256),
    displayName: z.string().trim().min(1).max(80),
    /**
     * Sponsor decision OQ-S2 (B-018): no self-service trader. Only `novice` is accepted; `trader`
     * is granted by passing the appropriateness assessment (POST /appropriateness/attempts).
     */
    accountType: z.literal('novice', { error: 'Everyone starts as novice. Pass the appropriateness assessment to unlock Pro trading.' }).default('novice'),
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

/** B-902: a one-time recovery code instead of the TOTP code (format XXXXX-XXXXX, case-insensitive). */
export const MfaRecoverySchema = z
  .object({
    mfaToken: z.string().min(10).max(4096),
    recoveryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/, 'Enter a recovery code like ABCDE-23456'),
  })
  .strict();

/** B-902: regenerating recovery codes needs a fresh TOTP code (step-up). */
export const RecoveryCodesRegenerateSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict();
