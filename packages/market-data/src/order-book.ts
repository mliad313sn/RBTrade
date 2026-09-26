import { dec, type DepthDelta, type DepthLevel, type DepthSnapshot } from '@kora/domain';

export type ApplyResult = 'ok' | 'stale' | 'gap' | 'no_snapshot';

/**
 * Local L2 book built from a snapshot plus sequenced deltas. A delta whose seq is not the next
 * expected one reports 'gap' and leaves the book untouched so the caller can resync.
 */
export class OrderBook {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private seqNo: number | null = null;
  source = '';
  exchangeTs = 0;

  constructor(readonly symbol: string) {}

  get seq(): number | null {
    return this.seqNo;
  }

  applySnapshot(s: DepthSnapshot): void {
    this.bids = new Map(s.bids.map(([p, q]) => [p, q]));
    this.asks = new Map(s.asks.map(([p, q]) => [p, q]));
    this.seqNo = s.seq;
    this.source = s.source;
    this.exchangeTs = s.exchangeTs;
  }

  applyDelta(d: DepthDelta): ApplyResult {
    if (this.seqNo === null) return 'no_snapshot';
    if (d.seq <= this.seqNo) return 'stale';
    const firstNeeded = d.prevSeq === undefined ? d.seq - 1 : d.prevSeq;
    if (firstNeeded > this.seqNo) return 'gap';
    for (const [p, q] of d.bids) apply(this.bids, p, q);
    for (const [p, q] of d.asks) apply(this.asks, p, q);
    this.seqNo = d.seq;
    this.exchangeTs = d.exchangeTs;
    return 'ok';
  }

  top(levels: number): { bids: DepthLevel[]; asks: DepthLevel[] } {
    return { bids: sorted(this.bids, true, levels), asks: sorted(this.asks, false, levels) };
  }

  snapshot(levels: number, receivedTs: number): DepthSnapshot | null {
    if (this.seqNo === null) return null;
    return {
      type: 'depth_snapshot',
      symbol: this.symbol,
      ...this.top(levels),
      source: this.source,
      exchangeTs: this.exchangeTs,
      receivedTs,
      seq: this.seqNo,
    };
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.seqNo = null;
  }
}

function apply(side: Map<string, string>, price: string, size: string): void {
  if (dec(size).isZero()) side.delete(price);
  else side.set(price, size);
}

function sorted(side: Map<string, string>, desc: boolean, levels: number): DepthLevel[] {
  return [...side.entries()]
    .map(([p, q]) => ({ p, q, d: dec(p) }))
    .sort((a, b) => (desc ? b.d.cmp(a.d) : a.d.cmp(b.d)))
    .slice(0, levels)
    .map(({ p, q }) => [p, q] as DepthLevel);
}

/** Delta that turns `prev` into `next` (levels missing from `next` are removed with size 0). */
export function diffDepth(prev: DepthSnapshot, next: DepthSnapshot, zero: string): DepthDelta {
  const side = (a: DepthLevel[], b: DepthLevel[]): DepthLevel[] => {
    const before = new Map(a);
    const after = new Map(b);
    const changes: DepthLevel[] = [];
    for (const [p, q] of after) if (before.get(p) !== q) changes.push([p, q]);
    for (const p of before.keys()) if (!after.has(p)) changes.push([p, zero]);
    return changes;
  };
  return {
    type: 'depth_delta',
    symbol: next.symbol,
    bids: side(prev.bids, next.bids),
    asks: side(prev.asks, next.asks),
    source: next.source,
    exchangeTs: next.exchangeTs,
    receivedTs: next.receivedTs,
    seq: next.seq,
  };
}
