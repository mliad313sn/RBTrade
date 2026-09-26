import { Placeholder } from '@/components/Placeholder';

export const metadata = { title: 'Learn' };

export default function Page() {
  return (
    <>
      <h1 className="k-sr-only">Learn</h1>
      <Placeholder title="Learn" goal="goal 08 (plain-language guides and risk disclosures)" />
    </>
  );
}
