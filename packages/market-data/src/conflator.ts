/**
 * Server-side conflation for UI channels (goal 02): at most `maxPerWindow` sends per channel in
 * any sliding `windowMs` window (default 10 per 1000 ms). A steady stream at or under the limit
 * passes straight through with no added latency; above it, only the latest value is kept and sent
 * as soon as the window frees, so the final value is never lost.
 */

export interface ConflatorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: ConflatorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface ChannelState<T> {
  sent: number[]; // ring of the last maxPerWindow send times
  head: number;
  pending: T | undefined;
  timer: unknown;
}

export class Conflator<T> {
  private readonly channels = new Map<string, ChannelState<T>>();
  conflated = 0;

  constructor(
    private readonly send: (channel: string, value: T) => void,
    private readonly maxPerWindow = 10,
    private readonly windowMs = 1000,
    private readonly clock: ConflatorClock = systemClock,
  ) {
    if (maxPerWindow < 1) throw new RangeError('maxPerWindow must be >= 1');
  }

  offer(channel: string, value: T): void {
    let st = this.channels.get(channel);
    if (!st) {
      st = { sent: [], head: 0, pending: undefined, timer: undefined };
      this.channels.set(channel, st);
    }
    if (st.timer !== undefined) {
      if (st.pending !== undefined) this.conflated += 1;
      st.pending = value;
      return;
    }
    const now = this.clock.now();
    const wait = this.waitMs(st, now);
    if (wait <= 0) {
      this.emit(channel, st, value, now);
      return;
    }
    st.pending = value;
    st.timer = this.clock.setTimeout(() => this.flush(channel), wait);
  }

  /** Drops state (and any pending value) for a channel nobody listens to any more. */
  drop(channel: string): void {
    const st = this.channels.get(channel);
    if (st?.timer !== undefined) this.clock.clearTimeout(st.timer);
    this.channels.delete(channel);
  }

  close(): void {
    for (const ch of [...this.channels.keys()]) this.drop(ch);
  }

  private flush(channel: string): void {
    const st = this.channels.get(channel);
    if (!st) return;
    st.timer = undefined;
    const value = st.pending;
    st.pending = undefined;
    if (value === undefined) return;
    const now = this.clock.now();
    const wait = this.waitMs(st, now);
    if (wait <= 0) this.emit(channel, st, value, now);
    else {
      st.pending = value;
      st.timer = this.clock.setTimeout(() => this.flush(channel), wait);
    }
  }

  private waitMs(st: ChannelState<T>, now: number): number {
    if (st.sent.length < this.maxPerWindow) return 0;
    const oldest = st.sent[st.head]!;
    return oldest + this.windowMs - now;
  }

  private emit(channel: string, st: ChannelState<T>, value: T, now: number): void {
    if (st.sent.length < this.maxPerWindow) st.sent.push(now);
    else {
      st.sent[st.head] = now;
      st.head = (st.head + 1) % this.maxPerWindow;
    }
    this.send(channel, value);
  }
}
