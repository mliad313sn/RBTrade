import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashOf } from '../core/hash';
import type { AiProvider, ProviderRequest, ProviderTurn } from '../core/types';

/**
 * Cassettes: a live run can be recorded (`KORA_AI_RECORD_DIR`) and replayed later without a key
 * (`KORA_AI_PROVIDER=replay`, `KORA_AI_REPLAY_DIR`). The key is the hash of the full request, so a
 * changed prompt, tool schema or tool output is a cache miss, never a stale answer.
 */
export function cassetteKey(req: ProviderRequest): string {
  return hashOf({
    system: req.system,
    tools: req.tools.map((t) => ({ name: t.name, schema: t.input_schema })),
    messages: req.messages,
    // Structured-output requests (goal 07B) also key on the schema; chat cassettes are unchanged.
    ...(req.outputFormat ? { outputFormat: req.outputFormat } : {}),
  });
}

export class ReplayProvider implements AiProvider {
  readonly kind = 'replay' as const;
  readonly modelId: string;

  constructor(private readonly dir: string) {
    const meta = join(dir, 'model.txt');
    this.modelId = `replay:${existsSync(meta) ? readFileSync(meta, 'utf8').trim() : 'unknown'}`;
  }

  async complete(
    req: ProviderRequest,
    onTextDelta?: (delta: string) => void,
  ): Promise<ProviderTurn> {
    const file = join(this.dir, `${cassetteKey(req)}.json`);
    if (!existsSync(file)) throw new Error(`replay cassette missing: ${file}`);
    const turn = JSON.parse(readFileSync(file, 'utf8')) as ProviderTurn;
    if (onTextDelta) for (const b of turn.content) if (b.type === 'text') onTextDelta(b.text);
    return turn;
  }
}

/** Wraps a provider and writes each turn as a cassette. */
export class RecordingProvider implements AiProvider {
  readonly kind: AiProvider['kind'];
  readonly modelId: string;

  constructor(
    private readonly inner: AiProvider,
    private readonly dir: string,
  ) {
    this.kind = inner.kind;
    this.modelId = inner.modelId;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.txt'), inner.modelId);
  }

  async complete(
    req: ProviderRequest,
    onTextDelta?: (delta: string) => void,
  ): Promise<ProviderTurn> {
    const turn = await this.inner.complete(req, onTextDelta);
    writeFileSync(join(this.dir, `${cassetteKey(req)}.json`), JSON.stringify(turn));
    return turn;
  }
}
