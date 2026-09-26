'use client';

import { hasAnyRole, KILL_SWITCH_SCOPE_LABELS, type Role } from '@kora/domain';
import { KoraApiError } from '@kora/sdk';
import { Banner, Button, Dialog, useToast } from '@kora/ui';
import { useState } from 'react';

import { refreshAccount, useAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';

import { useShell } from './ShellContext';

const RESUME_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

/**
 * Minimal halted state (goal 03; the full terminal treatment is goal 04): shows that the kill switch
 * is active, what it did and why, and lets an authorised user resume with a written reason.
 */
export function TradingHaltBanner({ className }: { className?: string }) {
  const { me } = useShell();
  const { account } = useAccount();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!account?.halt.halted || !account.halt.scope) return null;
  const canResume = hasAnyRole(me.roles, RESUME_ROLES);
  const since = account.halt.haltedAt ? new Date(account.halt.haltedAt).toISOString().slice(11, 16) : null;

  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resumeTrading(reason.trim());
      setOpen(false);
      setReason('');
      toast.push('Trading resumed. The resume and your reason are in the audit log.', 'success', 6000);
      refreshAccount();
    } catch (e) {
      setError(e instanceof KoraApiError ? e.message : 'Could not resume. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className} data-testid="halt-banner">
      <Banner
        tone="critical"
        title={`Trading halted: ${KILL_SWITCH_SCOPE_LABELS[account.halt.scope].title}${since ? ` since ${since} UTC` : ''}.`}
        action={
          canResume ? (
            <Button size="sm" onClick={() => setOpen(true)} data-testid="resume-trading">
              Resume trading
            </Button>
          ) : null
        }
      >
        Robots are stopped and cannot place orders.{account.halt.reason ? ` Reason: ${account.halt.reason}.` : ''}{' '}
        {canResume ? 'Resuming needs a written reason and is audited.' : 'A trader, risk officer or admin must resume trading.'}
      </Banner>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Resume trading"
        description="Robots may place orders again after you resume. Explain why it is safe; this is written to the audit log."
        data-testid="resume-dialog"
      >
        <label className="k-label block mb-1" htmlFor="resume-reason">
          Reason
        </label>
        <textarea
          id="resume-reason"
          className="k-input w-full min-h-20"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          aria-describedby={error ? 'resume-error' : undefined}
        />
        {error ? (
          <p id="resume-error" className="k-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="k-dialog__actions">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy || reason.trim().length < 3} onClick={() => void resume()} data-testid="confirm-resume">
            Resume trading
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
