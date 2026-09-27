'use client';

import { HOTKEY_LABELS } from '@kora/domain';
import { Dialog, Kbd } from '@kora/ui';
import Link from 'next/link';

import { hotkeyParts, isMacPlatform } from '@/lib/terminal/hotkeys';
import { useTerminal } from '@/lib/terminal/store';

import { useHotkeys } from './TerminalContext';

/** Hotkey cheat sheet (?): lists the user's current bindings (configurable in Settings). */
export function HotkeyCheatSheet() {
  const open = useTerminal((s) => s.cheatSheetOpen);
  const setOpen = useTerminal((s) => s.setCheatSheet);
  const hotkeys = useHotkeys();
  const mac = isMacPlatform();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Keyboard shortcuts"
      description="Change them in Settings. Single-key shortcuts are ignored while you type in a field."
      data-testid="hotkey-cheatsheet"
    >
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 m-0 text-sm">
        {Object.entries(hotkeys).map(([id, spec]) => (
          <div key={id} className="contents">
            <dt>{HOTKEY_LABELS[id] ?? id}</dt>
            <dd className="m-0 flex gap-1 justify-end">
              {hotkeyParts(spec, mac).map((k, i) => (
                <Kbd key={`${k}-${i}`}>{k}</Kbd>
              ))}
            </dd>
          </div>
        ))}
        <div className="contents">
          <dt>Close dialog</dt>
          <dd className="m-0 flex justify-end">
            <Kbd>Esc</Kbd>
          </dd>
        </div>
        <div className="contents">
          <dt>Confirm in a dialog</dt>
          <dd className="m-0 flex justify-end">
            <Kbd>Enter</Kbd>
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted mt-3 mb-0">
        <Link href="/settings" className="underline">
          Edit shortcuts in Settings
        </Link>
      </p>
    </Dialog>
  );
}
