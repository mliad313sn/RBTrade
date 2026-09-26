import type Anthropic from '@anthropic-ai/sdk';
import type { Role } from '@kora/domain';

export type Surface = 'chat' | 'strip' | 'why' | 'robots' | 'explain' | 'eval';
export type AiMode = 'pro' | 'novice';

export interface AiUser {
  id: string;
  roles: Role[];
  orgId: string;
}

/** Text that did not come from KORA or the user's question: always wrapped as data. */
export interface UntrustedInput {
  source: 'news' | 'note' | 'calendar' | 'strategy' | 'robot' | 'other';
  id?: string;
  text: string;
}

/** What the user is looking at (the focused panel), passed as context. */
export interface AiContext {
  panel?: string;
  symbol?: string;
  timeframe?: string;
  robotId?: string;
  signalId?: string;
  strategyId?: string;
  backtestId?: string;
}

export interface AiAsk {
  user: AiUser;
  surface: Surface;
  mode: AiMode;
  message: string;
  context: AiContext;
  untrusted?: UntrustedInput[];
  /** Data the server fetched before the call (why-panel features, strip drivers): part of the prompt. */
  grounding?: Record<string, unknown>;
}

export interface ProviderRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderTurn {
  content: Anthropic.ContentBlockParam[];
  stopReason: Anthropic.StopReason | null;
  usage: ProviderUsage;
}

export interface AiProvider {
  readonly kind: 'anthropic' | 'scripted' | 'replay';
  /** Recorded in every audit event. The scripted provider reports `scripted:<persona>`. */
  readonly modelId: string;
  complete(req: ProviderRequest, onTextDelta?: (delta: string) => void): Promise<ProviderTurn>;
}

export const DISCLAIMER = 'Not investment advice.';
