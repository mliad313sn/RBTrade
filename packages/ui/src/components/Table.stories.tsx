import type { Meta, StoryObj } from '@storybook/react-vite';

import { DirectionBadge } from './DirectionBadge';
import { Price } from './Money';
import { Table, type Column } from './Table';

interface Row {
  symbol: string;
  last: string;
  chg: string;
  precision: number;
}
const rows: Row[] = Array.from({ length: 500 }, (_, i) => ({
  symbol: `SIM${String(i).padStart(3, '0')}`,
  last: `${100 + (i % 37)}.${String(i % 100).padStart(2, '0')}`,
  chg: `${i % 3 === 0 ? '-' : ''}0.00${i % 9}`,
  precision: 2,
}));
const columns: Column<Row>[] = [
  { key: 'symbol', header: 'Symbol', cell: (r) => r.symbol },
  {
    key: 'last',
    header: 'Last',
    numeric: true,
    cell: (r) => <Price value={r.last} precision={r.precision} />,
  },
  {
    key: 'chg',
    header: 'Chg',
    numeric: true,
    width: '110px',
    cell: (r) => <DirectionBadge value={r.chg} format="percent" />,
  },
];

function Demo({ count }: { count: number }) {
  return (
    <Table
      label="Simulated instruments"
      columns={columns}
      rows={rows.slice(0, count)}
      rowKey={(r) => r.symbol}
      height={240}
    />
  );
}

const meta = { title: 'Primitives/Table', component: Demo, args: { count: 500 } } satisfies Meta<
  typeof Demo
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Virtualised: Story = {};
export const Empty: Story = { args: { count: 0 } };
