import { unavailableReason, type AiConfig } from '../core/config';
import type { AiProvider } from '../core/types';
import { AnthropicProvider } from './anthropic.provider';
import { RecordingProvider, ReplayProvider } from './replay.provider';
import { ScriptedProvider } from './scripted.provider';

/**
 * Picks the provider from config. Returns `{provider: null, reason}` when the copilot must fail
 * closed (no model id, no key, missing replay directory); callers show the friendly message.
 */
export function selectProvider(cfg: AiConfig): {
  provider: AiProvider | null;
  reason: string | null;
} {
  if (cfg.provider === 'scripted')
    return { provider: new ScriptedProvider(cfg.persona), reason: null };
  if (cfg.provider === 'replay') {
    if (!cfg.replayDir) return { provider: null, reason: 'KORA_AI_REPLAY_DIR is not set' };
    return { provider: new ReplayProvider(cfg.replayDir), reason: null };
  }
  const reason = unavailableReason(cfg);
  if (reason) return { provider: null, reason };
  const live = new AnthropicProvider(cfg);
  return {
    provider: cfg.recordDir ? new RecordingProvider(live, cfg.recordDir) : live,
    reason: null,
  };
}
