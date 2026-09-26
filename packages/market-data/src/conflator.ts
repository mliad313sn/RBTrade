/**
 * Server-side conflation for UI channels (goal 02): a per-channel token bucket, refilled at
 * `ratePerSec` (default 10) with a small `burst` capacity (default 2). Guarantees: never more than
 * `ratePerSec` updates per second sustained, and at most `ratePerSec·T/1000 + burst` in any window
 * of T ms (≤ 12 in any second at the defaults). Above the rate only the latest value is kept and it
 * is sent as soon as a token is available, so the final value is never lost.
 *
 * Why not a strict "10 in any sliding second" window: fed at exactly 10 Hz, a sliding window echoes
 * every jitter or GC pause forward (each late send shifts the window for the send ten messages
 * later), and the measured median delay grew to ~16 ms under load. The burst of 2 absorbs up to
 * 200 ms of jitter, so a 10 Hz feed passes through undelayed.
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
  tokens: number;
  refilledAt: number;
  pending: T | undefined;
  timer: unknown;
}

export class Conflator<T> {
  private readonly channels = new Map<string, ChannelState<T>>();
  private readonly msPerToken: number;
  conflated = 0;

  constructor(
    private readonly send: (channel: string, value: T) => void,
    private readonly ratePerSec = 10,
    private readonly burst = 2,
    private readonly clock: ConflatorClock = systemClock,
  ) {
    if (ratePerSec <= 0) throw new RangeError('ratePerSec must be > 0');
    if (burst < 1) throw new RangeError('burst must be >= 1');
    this.msPerToken = 1000 / ratePerSec;
  }

  offer(channel: string, value: T): void {
    let st = this.channels.get(channel);
    if (!st) {
      st = { tokens: this.burst, refilledAt: this.clock.now(), pending: undefined, timer: undefined };
      this.channels.set(channel, st);
    }
    if (st.timer !== undefined) {
      if (st.pending !== undefined) this.conflated += 1;
      st.pending = value;
      return;
    }
    this.refill(st);
    if (st.tokens >= 1) {
      st.tokens -= 1;
      this.send(channel, value);
      return;
    }
    st.pending = value;
    this.schedule(channel, st);
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

  private refill(st: ChannelState<T>): void {
    const now = this.clock.now();
    st.tokens = Math.min(this.burst, st.tokens + (now - st.refilledAt) / this.msPerToken);
    st.refilledAt = now;
  }

  private schedule(channel: string, st: ChannelState<T>): void {
    const wait = Math.max(1, Math.ceil((1 - st.tokens) * this.msPerToken));
    st.timer = this.clock.setTimeout(() => this.flush(channel), wait);
  }

  private flush(channel: string): void {
    const st = this.channels.get(channel);
    if (!st) return;
    st.timer = undefined;
    this.refill(st);
    const value = st.pending;
    if (value === undefined) return;
    if (st.tokens >= 1 - 1e-9) {
      st.tokens = Math.max(0, st.tokens - 1);
      st.pending = undefined;
      this.send(channel, value);
    } else {
      this.schedule(channel, st);
    }
  }
}
