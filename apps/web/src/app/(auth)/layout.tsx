import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div data-theme="novice-light" className="k-root min-h-screen flex flex-col">
      <header className="flex items-center gap-3 px-6 py-5">
        <span aria-hidden="true" className="text-accent text-xl">
          ↗
        </span>
        <span className="font-display text-2xl">Kora</span>
        <span className="k-chip k-chip--paper ml-auto" role="status">
          Practice money only
        </span>
      </header>
      <main id="main" className="flex-1 flex items-start justify-center px-4 pb-12 pt-4">
        {children}
      </main>
    </div>
  );
}
