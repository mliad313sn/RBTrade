'use client';

import { useId, type HTMLAttributes, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  actions?: ReactNode;
  bodyClassName?: string;
}

export function Panel({ title, actions, children, className, bodyClassName, ...rest }: PanelProps) {
  const id = useId();
  return (
    <section className={cx('k-panel', className)} aria-labelledby={title ? id : undefined} {...rest}>
      {title || actions ? (
        <header className="k-panel__head">
          {title ? (
            <h2 id={id} className="k-panel__title">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {actions}
        </header>
      ) : null}
      <div className={cx('k-panel__body', bodyClassName)}>{children}</div>
    </section>
  );
}
