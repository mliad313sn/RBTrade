'use client';

import { KoraApiError, type LoginResponse } from '@kora/sdk';
import { Banner, Button, Input } from '@kora/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';

import { api } from '@/lib/api-browser';
import { safeNext } from '@/lib/safe-next';

type Step =
  | { kind: 'credentials' }
  | { kind: 'enroll'; mfaToken: string; secret?: string; otpauthUrl?: string; qr?: string }
  | { kind: 'verify'; mfaToken: string; recovery?: boolean }
  | { kind: 'recovery-codes'; codes: string[] };

function message(e: unknown): string {
  if (e instanceof KoraApiError) {
    const issues = (e.body as { issues?: Array<{ message: string }> } | undefined)?.issues;
    return issues?.length ? issues.map((i) => i.message).join('. ') : e.message;
  }
  return 'Something went wrong. Please try again.';
}

export function AuthFlow({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');

  const done = () => {
    router.replace(safeNext(params.get('next')));
    router.refresh();
  };

  const handleLogin = (res: LoginResponse) => {
    if (res.status === 'ok') return done();
    setCode('');
    setStep(res.status === 'mfa_required' ? { kind: 'verify', mfaToken: res.mfaToken } : { kind: 'enroll', mfaToken: res.mfaToken });
  };

  useEffect(() => {
    if (step.kind !== 'enroll' || step.secret) return;
    let cancelled = false;
    api
      .mfaEnroll(step.mfaToken)
      .then(async (r) => {
        const qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 180 });
        if (!cancelled) setStep({ ...step, secret: r.secret, otpauthUrl: r.otpauthUrl, qr });
      })
      .catch((e: unknown) => !cancelled && setError(message(e)));
    return () => {
      cancelled = true;
    };
  }, [step]);

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') await api.signup({ email, password, displayName });
      handleLogin(await api.login(email, password));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (step.kind === 'credentials' || step.kind === 'recovery-codes') return;
    setError(null);
    setBusy(true);
    try {
      if (step.kind === 'verify' && step.recovery) {
        await api.mfaRecovery(step.mfaToken, code.trim());
        return done();
      }
      if (step.kind !== 'enroll' && step.kind !== 'verify') return;
      const res = await api.mfaVerify(step.mfaToken, code.trim());
      // B-902: show the one-time recovery codes once, right after enrolment.
      if (res.recoveryCodes?.length) return setStep({ kind: 'recovery-codes', codes: res.recoveryCodes });
      done();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const title =
    step.kind === 'enroll'
      ? 'Set up two-factor authentication'
      : step.kind === 'recovery-codes'
        ? 'Save your recovery codes'
        : step.kind === 'verify'
          ? step.recovery
            ? 'Enter a recovery code'
            : 'Enter your 6-digit code'
          : mode === 'signup'
            ? 'Create your KORA account'
            : 'Sign in to KORA';
  const recovering = step.kind === 'verify' && !!step.recovery;

  return (
    <div className="k-panel w-full max-w-md" data-testid="auth-card">
      <div className="p-6 flex flex-col gap-4">
        <h1 className="font-display text-3xl m-0">{title}</h1>
        {error ? (
          <Banner tone="critical" title="Couldn't continue.">
            <span data-testid="auth-error">{error}</span>
          </Banner>
        ) : null}

        {step.kind === 'credentials' && process.env.NEXT_PUBLIC_AUTH_PROVIDER === 'keycloak' ? (
          // Full-page navigation to the API's OIDC redirect endpoint (not a Next page).
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a className="k-btn k-btn--primary k-btn--lg k-btn--block" href="/api/auth/oidc/start">
            Continue with KORA single sign-on
          </a>
        ) : step.kind === 'credentials' ? (
          <form className="flex flex-col gap-4" onSubmit={submitCredentials} noValidate>
            {mode === 'signup' ? (
              <Input label="Your name" name="displayName" autoComplete="name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            ) : null}
            <Input label="Email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 12 : undefined}
              hint={mode === 'signup' ? 'At least 12 characters' : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'signup' ? (
              <p className="m-0 text-sm text-muted" data-testid="signup-appropriateness-note">
                Everyone starts in the Simple view with practice money: plain language, protective limits on, no borrowing. To unlock the Pro
                terminal, take a short appropriateness assessment after signing up; Pro accounts then set up two-factor authentication.
              </p>
            ) : null}
            <Button type="submit" variant="primary" size="lg" block disabled={busy}>
              {mode === 'signup' ? 'Create account' : 'Sign in'}
            </Button>
            <p className="text-sm text-muted m-0">
              {mode === 'signup' ? (
                <>
                  Already have an account? <Link href="/login" className="text-accent underline">Sign in</Link>
                </>
              ) : (
                <>
                  New to KORA? <Link href="/signup" className="text-accent underline">Create an account</Link>
                </>
              )}
            </p>
          </form>
        ) : step.kind === 'recovery-codes' ? (
          <div className="flex flex-col gap-4" data-testid="recovery-codes">
            <p className="m-0">
              If you lose your authenticator app, each of these codes lets you sign in once. Store them somewhere safe, like a password manager.
              They are shown only now.
            </p>
            <ul className="grid grid-cols-2 gap-2 m-0 p-0 list-none k-num" aria-label="Recovery codes">
              {step.codes.map((c) => (
                <li key={c} className="k-panel px-2 py-1 text-center">
                  {c}
                </li>
              ))}
            </ul>
            <Button variant="primary" size="lg" block onClick={done}>
              I have saved my codes
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submitCode} noValidate>
            {step.kind === 'enroll' ? (
              <div className="flex flex-col gap-3" data-testid="mfa-enroll">
                <p className="m-0">
                  Scan this code with an authenticator app (for example 1Password, Google Authenticator or Authy), then enter the 6-digit code it shows.
                </p>
                {step.qr ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={step.qr} width={180} height={180} alt="QR code for your authenticator app" className="self-center" />
                ) : (
                  <p className="text-muted">Preparing your code…</p>
                )}
                {step.secret ? (
                  <p className="m-0 text-sm">
                    Can&apos;t scan? Enter this key: <code className="k-num break-all" data-testid="mfa-secret">{step.secret}</code>
                  </p>
                ) : null}
              </div>
            ) : recovering ? (
              <p className="m-0">Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once.</p>
            ) : (
              <p className="m-0">Open your authenticator app and enter the current code for KORA.</p>
            )}
            {recovering ? (
              <Input
                label="Recovery code"
                name="recoveryCode"
                autoComplete="off"
                maxLength={11}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-7-]/g, ''))}
              />
            ) : (
              <Input
                label="6-digit code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            )}
            <Button type="submit" variant="primary" size="lg" block disabled={busy || (recovering ? code.replace(/-/g, '').length !== 10 : code.length !== 6)}>
              {step.kind === 'enroll' ? 'Turn on two-factor and continue' : 'Verify'}
            </Button>
            {step.kind === 'verify' ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setCode('');
                  setError(null);
                  setStep({ kind: 'verify', mfaToken: step.mfaToken, recovery: !step.recovery });
                }}
              >
                {step.recovery ? 'Use my authenticator app instead' : 'Lost your authenticator? Use a recovery code'}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setStep({ kind: 'credentials' })}>
              Start again
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
