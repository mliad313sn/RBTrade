import Link from 'next/link';

export const metadata = { title: 'Not available on your account' };

export default async function Forbidden({
  searchParams,
}: {
  searchParams: Promise<{ feature?: string }>;
}) {
  const { feature } = await searchParams;
  return (
    <div
      data-theme="novice-light"
      className="k-root min-h-screen flex items-center justify-center p-6"
    >
      <main className="k-panel max-w-lg w-full p-8" aria-labelledby="forbidden-title">
        <p className="text-sm text-muted mb-2">Error 403 · Access limited</p>
        <h1 id="forbidden-title" className="font-display text-3xl mb-3">
          {feature ?? 'This area'} isn&apos;t part of your account
        </h1>
        <p className="mb-4">
          Your account type doesn&apos;t include this feature. Nothing has changed and no money is
          at risk. If you think you should have access, ask an administrator to review your account
          type.
        </p>
        <p className="mb-6 text-muted">
          Ready-made robots are available in <strong>Auto-invest</strong>, where you can try them
          with practice money.
        </p>
        <div className="flex gap-3 flex-wrap">
          <Link href="/" className="k-btn k-btn--primary">
            Back to my home
          </Link>
          <Link href="/auto-invest" className="k-btn">
            Go to Auto-invest
          </Link>
        </div>
      </main>
    </div>
  );
}
