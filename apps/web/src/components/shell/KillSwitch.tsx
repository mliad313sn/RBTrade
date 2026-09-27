'use client';

import { KILL_SWITCH_HOLD_MS, KILL_SWITCH_SCOPE_LABELS, KILL_SWITCH_SCOPES, type KillSwitchScope } from '@kora/domain';
import { Button, Dialog, HoldToConfirmButton, Kbd, useToast, type HoldHandle } from '@kora/ui';
import { useEffect, useRef, useState } from 'react';

import { refreshAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';
import { useHoldLabels } from '@/lib/i18n/hold';
import { useI18n } from '@/lib/i18n/react';

/**
 * Kill switch: 1.5 s hold (mouse, touch, keyboard Space/Enter, or the Ctrl+Shift+K hotkey held), or a
 * single activation (tap, screen reader, voice control; IRTC R5-04) → three-scope menu → REST call to the goal 03 engine (halt robots, cancel orders, flatten), which
 * works without the websocket. The result (orders cancelled, positions closed) is shown and audited.
 */
export function KillSwitch({ compact = false }: { compact?: boolean }) {
  const hold = useRef<HoldHandle>(null);
  const source = useRef<'ui_button' | 'hotkey'>('ui_button');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<KillSwitchScope | null>(null);
  // Set once the handlers are attached (after hydration), so tests do not press a server-rendered button.
  const [ready, setReady] = useState(false);
  const toast = useToast();

  useEffect(() => setReady(true), []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k') && !e.repeat) {
        e.preventDefault();
        source.current = 'hotkey';
        hold.current?.start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (source.current === 'hotkey' && ['K', 'k', 'Control', 'Shift'].includes(e.key)) hold.current?.cancel();
    };
    const blur = () => hold.current?.cancel();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Goal 08: the Novice view gets plain, localised wording and a 44 px button; Pro is unchanged.
  const { t, novice } = useI18n();
  const hold18n = useHoldLabels();
  const plainNovice = compact && novice;

  const choose = async (scope: KillSwitchScope) => {
    setBusy(scope);
    try {
      const r = await api.killSwitch(scope, source.current);
      setOpen(false);
      const parts = plainNovice ? [t('kill.done')] : [`Kill switch: ${r.label}.`, 'Robots halted.'];
      if (plainNovice) {
        if (scope !== 'robots') parts.push(t('kill.doneOrders', { n: r.ordersCancelled }));
        if (scope === 'robots_cancel_flatten') {
          parts.push(t('kill.doneClosed', { n: r.positionsFlattened }));
          if (r.flattenPending.length) parts.push(t('kill.donePending', { n: r.flattenPending.length }));
        }
        parts.push(t('kill.doneAudit', { id: r.auditEventId }));
      } else {
        if (scope !== 'robots') parts.push(`${r.ordersCancelled} order${r.ordersCancelled === 1 ? '' : 's'} cancelled.`);
        if (scope === 'robots_cancel_flatten') {
          parts.push(`${r.positionsFlattened} position${r.positionsFlattened === 1 ? '' : 's'} closed.`);
          if (r.flattenPending.length) parts.push(`${r.flattenPending.length} waiting for a safe market.`);
        }
        parts.push(`Audit event #${r.auditEventId}.`);
      }
      toast.push(parts.join(' '), 'success', 10000);
      refreshAccount();
    } catch {
      toast.push(plainNovice ? t('kill.failed') : 'Kill switch request failed. Try again or use the REST fallback.', 'critical', 10000);
    } finally {
      setBusy(null);
      source.current = 'ui_button';
    }
  };

  return (
    <>
      <HoldToConfirmButton
        ref={hold}
        holdMs={KILL_SWITCH_HOLD_MS}
        variant="danger"
        size={compact && novice ? 'lg' : 'sm'}
        onConfirm={() => setOpen(true)}
        // IRTC R5-04: a tap, a screen-reader or voice-control activation opens the scope menu, which is
        // itself the explicit confirmation (a scope must be chosen); the hold stays as the fast path.
        onActivate={() => setOpen(true)}
        labels={hold18n.labels}
        locale={hold18n.locale}
        description={plainNovice ? t('kill.help') : 'Opens the kill-switch scope menu. Hotkey: hold Control, Shift and K.'}
        data-testid="kill-switch"
        data-ready={ready ? 'true' : undefined}
      >
        {compact ? (novice ? t('kill.button') : 'Stop everything') : '■ KILL SWITCH'}
      </HoldToConfirmButton>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) source.current = 'ui_button';
        }}
        alert
        title={plainNovice ? t('kill.title') : 'Kill switch — choose a scope'}
        description={plainNovice ? t('kill.desc') : 'Every choice is written to the audit log. Paper environment.'}
        data-testid="kill-switch-menu"
      >
        <div className="flex flex-col gap-2" role="group" aria-label={plainNovice ? t('kill.scopes') : 'Kill switch scopes'}>
          {KILL_SWITCH_SCOPES.map((scope, i) => (
            <button
              key={scope}
              type="button"
              className="k-btn k-btn--danger justify-start! text-left! h-auto! py-2!"
              style={{ whiteSpace: 'normal' }}
              disabled={busy !== null}
              onClick={() => void choose(scope)}
              data-testid={`kill-scope-${scope}`}
            >
              <span className="k-num mr-2" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <span className="block">{plainNovice ? t(`kill.scope.${scope}.title`) : KILL_SWITCH_SCOPE_LABELS[scope].title}</span>
                <span className="block text-muted font-normal">
                  {plainNovice ? t(`kill.scope.${scope}.detail`) : KILL_SWITCH_SCOPE_LABELS[scope].detail}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="k-dialog__actions">
          <span className="text-muted text-xs mr-auto">
            {plainNovice ? t('kill.keys') : 'Hotkey: hold'} <Kbd>Ctrl</Kbd> <Kbd>Shift</Kbd> <Kbd>K</Kbd>
          </span>
          <Button onClick={() => setOpen(false)}>{plainNovice ? t('common.cancel') : 'Cancel'}</Button>
        </div>
      </Dialog>
    </>
  );
}
