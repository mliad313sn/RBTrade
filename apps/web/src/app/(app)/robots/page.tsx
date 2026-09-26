import { Placeholder } from '@/components/Placeholder';

export const metadata = { title: 'Robots' };

export default function Page() {
  return (
    <>
      <h1 className="k-sr-only">Robots</h1>
      <Placeholder title="Robots" goal="goal 06 (strategy builder, backtests, walk-forward)" />
    </>
  );
}
