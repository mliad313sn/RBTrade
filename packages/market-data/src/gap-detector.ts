/**
 * Sequence gap detector (goal 02 normalisation). One expected sequence per key (e.g.
 * "simulated|EURUSD|quote"). A gap means messages were missed and the consumer must resync
 * from a snapshot; duplicates and out-of-order messages are dropped.
 */

export type SeqCheck =
  | { status: 'first' }
  | { status: 'ok' }
  | { status: 'duplicate'; last: number }
  | { status: 'gap'; expected: number; got: number };

export class SeqGapDetector {
  private readonly last = new Map<string, number>();
  gaps = 0;

  check(key: string, seq: number): SeqCheck {
    const prev = this.last.get(key);
    if (prev === undefined) {
      this.last.set(key, seq);
      return { status: 'first' };
    }
    if (seq <= prev) return { status: 'duplicate', last: prev };
    this.last.set(key, seq);
    if (seq === prev + 1) return { status: 'ok' };
    this.gaps += 1;
    return { status: 'gap', expected: prev + 1, got: seq };
  }

  /** After a resync: the snapshot's seq becomes the last seen value. */
  reset(key: string, seq: number): void {
    this.last.set(key, seq);
  }

  forget(key: string): void {
    this.last.delete(key);
  }

  lastSeq(key: string): number | undefined {
    return this.last.get(key);
  }
}
