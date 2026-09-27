'use client';

import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** CSS grid track, e.g. "1fr" or "96px". */
  width?: string;
  numeric?: boolean;
}

export interface TableProps<T> {
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHeight?: number;
  /** Visible body height in px. */
  height?: number;
  empty?: ReactNode;
  className?: string;
}

/** Virtualised table (ARIA table pattern). Renders only visible rows; aria-rowcount keeps totals. */
export function Table<T>({
  label,
  columns,
  rows,
  rowKey,
  rowHeight = 28,
  height = 240,
  empty,
  className,
}: TableProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: { width: 800, height },
    // The body has a fixed height: fall back to it before layout (SSR, hidden tabs, jsdom).
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) =>
        cb(rect.height > 0 ? rect : { width: rect.width || 800, height }),
      ),
  });
  const grid = columns.map((c) => c.width ?? '1fr').join(' ');
  const items = virt.getVirtualItems();

  return (
    <div
      role="table"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      className={cx('k-table', className)}
    >
      <div role="rowgroup">
        <div
          role="row"
          aria-rowindex={1}
          className="k-table__row k-table__head"
          style={{ gridTemplateColumns: grid, height: rowHeight }}
        >
          {columns.map((c) => (
            <div
              key={c.key}
              role="columnheader"
              className={cx('k-table__cell', c.numeric && 'k-table__cell--num')}
            >
              {c.header}
            </div>
          ))}
        </div>
      </div>
      <div
        ref={scroller}
        role="rowgroup"
        className="k-table__body"
        style={{ height }}
        tabIndex={0}
        aria-label={`${label} rows`}
      >
        {rows.length === 0 ? (
          <div
            role="row"
            className="k-table__row"
            style={{ gridTemplateColumns: '1fr', height: rowHeight }}
          >
            <div role="cell" className="k-table__cell">
              {empty ?? 'Nothing here yet'}
            </div>
          </div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {items.map((vi) => {
              const row = rows[vi.index]!;
              return (
                <div
                  key={rowKey(row)}
                  role="row"
                  aria-rowindex={vi.index + 2}
                  className="k-table__row"
                  style={{
                    gridTemplateColumns: grid,
                    height: rowHeight,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      role="cell"
                      className={cx('k-table__cell', c.numeric && 'k-table__cell--num')}
                    >
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
