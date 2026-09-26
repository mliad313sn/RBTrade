import { Practice } from '@/components/sim/Practice';

export const metadata = { title: 'Practice' };

export default function Page() {
  return (
    <>
      <h1 className="k-sr-only">Practice</h1>
      <Practice />
    </>
  );
}
