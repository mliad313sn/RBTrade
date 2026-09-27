'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useImperativeHandle, useRef, type HTMLAttributes, type ReactNode, type Ref } from 'react';

export interface VirtualRowsHandle {
  scrollToIndex: (i: number) => void;
  element: () => HTMLDivElement | null;
}

export interface VirtualRowsProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  items: readonly T[];
  rowHeight: number;
  overscan?: number;
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number, pos: { size: number; start: number }) => ReactNode;
  handleRef?: Ref<VirtualRowsHandle>;
  /** Initial viewport size (tests and SSR, before the element is measured). */
  initialRect?: { width: number; height: number };
}

/**
 * Virtualised rows (TanStack Virtual): only the rows in view plus `overscan` are in the DOM, so a
 * 500-symbol watchlist stays cheap to stream into (goal 04).
 */
export function VirtualRows<T>({
  items,
  rowHeight,
  overscan = 6,
  getKey,
  renderRow,
  handleRef,
  initialRect,
  ...rest
}: VirtualRowsProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (i) => getKey(items[i]!, i),
    ...(initialRect ? { initialRect } : {}),
  });
  useImperativeHandle(
    handleRef,
    () => ({
      scrollToIndex: (i: number) => virtual.scrollToIndex(i),
      element: () => parentRef.current,
    }),
    [virtual],
  );
  return (
    <div ref={parentRef} {...rest}>
      <div
        style={{ height: virtual.getTotalSize(), position: 'relative' }}
        data-testid="virtual-spacer"
      >
        {virtual
          .getVirtualItems()
          .map((vi) => renderRow(items[vi.index]!, vi.index, { size: vi.size, start: vi.start }))}
      </div>
    </div>
  );
}
