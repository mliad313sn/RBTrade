import { hasExecutionClaim, ungroundedNumbers } from './guards';
import { normaliseText } from './normalise';
import type { AiMode } from './types';

/**
 * Guarded streaming (IRTC R4-01). Raw model deltas never reach a client. Text is held back until a
 * sentence is complete (`.`, `!` or `?` followed by whitespace, or a newline, so `1.0842` is never
 * split), then each sentence is checked with the same guards as the final answer against the sources
 * known so far (grounding, the question, the tool outputs of earlier rounds):
 * - no execution claim (on the text emitted so far plus the sentence, normalised);
 * - every figure grounded, and any confidence/probability calibrated with its n.
 *
 * The first sentence that fails trips the stream: nothing more is emitted for this answer, and the
 * client shows the guarded `final` answer, which replaces the streamed preview. Novice answers are
 * never streamed (they also need the readability check on the whole text).
 */
export class GuardedTextStream {
  private pending = '';
  private shown = '';
  private tripped = false;

  constructor(
    private readonly opts: {
      mode: AiMode;
      sources: () => unknown[];
      emit: (text: string) => void;
    },
  ) {}

  get isTripped(): boolean {
    return this.tripped;
  }

  /** A raw provider delta: buffered, never forwarded as is. */
  push(delta: string): void {
    if (this.tripped || this.opts.mode === 'novice') return;
    this.pending += delta;
    this.drain(false);
  }

  /** End of a provider turn: the last sentence may have no terminator. */
  endTurn(): void {
    if (this.tripped || this.opts.mode === 'novice') return;
    this.drain(true);
  }

  /** Stops streaming (e.g. the final answer differs from what the stream would show). */
  trip(): void {
    this.tripped = true;
    this.pending = '';
  }

  private drain(final: boolean): void {
    for (;;) {
      const m = /[.!?](?=\s)|\n/.exec(this.pending);
      let cut: number;
      if (m) cut = m.index + 1;
      else if (final && this.pending.trim()) cut = this.pending.length;
      else return;
      // Keep the whitespace that follows a sentence with it.
      while (cut < this.pending.length && /[ \t]/.test(this.pending[cut]!)) cut += 1;
      const sentence = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      if (!this.check(sentence)) {
        this.trip();
        return;
      }
      const out = normaliseText(sentence);
      this.shown += out;
      if (out) this.opts.emit(out);
    }
  }

  private check(sentence: string): boolean {
    if (!sentence.trim()) return true;
    const text = normaliseText(sentence);
    if (
      hasExecutionClaim(`${this.shown} ${sentence}`) ||
      hasExecutionClaim(`${this.shown} ${text}`)
    )
      return false;
    return ungroundedNumbers(text, this.opts.sources(), 'rounded').length === 0;
  }
}
