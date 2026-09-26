/**
 * Configurable hotkeys (goal 04). Specs look like "Ctrl+Shift+K", "Alt+1", "B", "Shift+?" or
 * "Mod+K" (⌘ on macOS, Ctrl elsewhere). Letters and digits match on the physical key
 * (`event.code`), so Alt+1 works on macOS where Alt changes the produced character.
 */

export interface ParsedHotkey {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export function parseHotkey(spec: string, isMac = false): ParsedHotkey | null {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  // "Shift++" style is not supported; "?" and other symbols are the last part.
  if (spec.endsWith('++')) parts.push('+');
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const known = ['ctrl', 'control', 'alt', 'option', 'shift', 'meta', 'cmd', 'mod'];
  if ([...mods].some((m) => !known.includes(m))) return null;
  const mod = mods.has('mod');
  return {
    key,
    ctrl: mods.has('ctrl') || mods.has('control') || (mod && !isMac),
    alt: mods.has('alt') || mods.has('option'),
    shift: mods.has('shift'),
    meta: mods.has('meta') || mods.has('cmd') || (mod && isMac),
  };
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function keyMatches(k: string, e: KeyLike): boolean {
  if (/^[a-z]$/i.test(k)) return e.code ? e.code === `Key${k.toUpperCase()}` : e.key.toLowerCase() === k.toLowerCase();
  if (/^[0-9]$/.test(k)) return e.code ? e.code === `Digit${k}` || e.code === `Numpad${k}` : e.key === k;
  if (k.toLowerCase() === 'esc' || k.toLowerCase() === 'escape') return e.key === 'Escape';
  return e.key.toLowerCase() === k.toLowerCase();
}

export function matchHotkey(e: KeyLike, spec: string, isMac = false): boolean {
  const p = parseHotkey(spec, isMac);
  if (!p) return false;
  // "?" is produced with Shift on most layouts: Shift is implied, not required to be declared.
  const shiftOk = p.key === '?' ? true : e.shiftKey === p.shift;
  return keyMatches(p.key, e) && e.ctrlKey === p.ctrl && e.altKey === p.alt && e.metaKey === p.meta && shiftOk;
}

/** True when single-key hotkeys must not fire (the user is typing). */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const t = el as HTMLElement;
  const tag = t.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || t.isContentEditable) return true;
  if (tag !== 'input') return false;
  const type = ((t as HTMLInputElement).type || 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
}

/** Whether a spec needs a modifier (safe to fire while typing). */
export function hasModifier(spec: string): boolean {
  const p = parseHotkey(spec);
  return Boolean(p && (p.ctrl || p.alt || p.meta || spec.toLowerCase().includes('mod')));
}

/** Display parts for <Kbd> chips, e.g. "Mod+K" → ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere. */
export function hotkeyParts(spec: string, isMac = false): string[] {
  return spec.split('+').filter(Boolean).map((p) => {
    const l = p.toLowerCase();
    if (l === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (l === 'meta' || l === 'cmd') return '⌘';
    if (l === 'alt' || l === 'option') return isMac ? '⌥' : 'Alt';
    if (l === 'enter') return 'Enter';
    return p.length === 1 ? p.toUpperCase() : p;
  });
}

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Validates a user-entered binding (Settings). */
export function isValidHotkey(spec: string): boolean {
  return spec.length <= 32 && parseHotkey(spec) !== null;
}
