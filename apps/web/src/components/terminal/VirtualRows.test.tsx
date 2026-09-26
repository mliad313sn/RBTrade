// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { VirtualRows, type VirtualRowsHandle } from './VirtualRows';

// jsdom has no layout: give elements a 225×450 box and a no-op ResizeObserver.
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ width: 225, height: 450, top: 0, left: 0, right: 225, bottom: 450, x: 0, y: 0, toJSON: () => ({}) }),
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 450 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 225 });
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('VirtualRows (watchlist virtualisation)', () => {
  it('renders only the visible window of a 500-row list and keeps the full scroll height', () => {
    const items = Array.from({ length: 500 }, (_, i) => `SYM${i}`);
    const handle = createRef<VirtualRowsHandle>();
    const { container } = render(
      <VirtualRows
        handleRef={handle}
        items={items}
        rowHeight={30}
        overscan={6}
        getKey={(s) => s}
        initialRect={{ width: 225, height: 450 }}
        style={{ height: 450, overflow: 'auto' }}
        renderRow={(s, i, pos) => (
          <div key={s} data-row={i} style={{ position: 'absolute', top: pos.start, height: pos.size }}>
            {s}
          </div>
        )}
      />,
    );
    const rows = container.querySelectorAll('[data-row]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(15 + 6 + 1); // 450 / 30 visible + overscan
    expect((container.querySelector('[data-testid="virtual-spacer"]') as HTMLElement).style.height).toBe('15000px');
    expect(container.querySelector('[data-row="499"]')).toBeNull();
    act(() => handle.current!.scrollToIndex(499));
    expect(handle.current!.element()).not.toBeNull();
  });
});
