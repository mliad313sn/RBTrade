import type { OrderType, Side, Timeframe, TimeInForce } from '@kora/domain';
import { create } from 'zustand';

/**
 * Terminal UI state shared by the panels, the ⌘K palette (mounted in the Pro shell) and goal 07's
 * copilot. The ticket prefill (`prefillTicket`) is the single entry point for drafts: order book
 * and chart clicks, blotter actions, and AI drafts all go through it; a human still reviews and
 * confirms every order (master goal: "AI suggests, never executes").
 */

export interface TicketDraft {
  symbol?: string;
  side?: Side;
  type?: OrderType;
  /** Units (registry quantity). */
  qty?: string;
  limitPrice?: string;
  stopPrice?: string;
  trailAmount?: string;
  stopLossPrice?: string;
  takeProfitPrice?: string;
  tif?: TimeInForce;
  reduceOnly?: boolean;
  /** Where the draft came from. `ai` drafts are sent with source `ai-draft-accepted` once confirmed. */
  origin?: 'manual' | 'order_book' | 'chart' | 'blotter' | 'ai';
  /** Shown above the ticket, e.g. the copilot's one-line rationale. */
  note?: string;
  /** Goal 07: the audited AI draft behind an `ai` prefill; the ticket records the user's decision. */
  aiDraftId?: string;
}

export type PanelTarget = 'watchlist' | 'chart' | 'orderbook' | 'ticket' | 'blotter';

interface TerminalState {
  symbol: string;
  timeframe: Timeframe;
  draft: (TicketDraft & { nonce: number }) | null;
  focus: { target: PanelTarget | 'ticket-buy' | 'ticket-sell' | 'ticket-submit'; nonce: number } | null;
  cheatSheetOpen: boolean;
  setSymbol: (symbol: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  prefillTicket: (draft: TicketDraft) => void;
  requestFocus: (target: NonNullable<TerminalState['focus']>['target']) => void;
  setCheatSheet: (open: boolean) => void;
}

let nonce = 0;

export const useTerminal = create<TerminalState>((set) => ({
  symbol: 'EURUSD',
  timeframe: '15m',
  draft: null,
  focus: null,
  cheatSheetOpen: false,
  setSymbol: (symbol) => set({ symbol }),
  setTimeframe: (timeframe) => set({ timeframe }),
  prefillTicket: (draft) => set((s) => ({ draft: { ...draft, nonce: ++nonce }, symbol: draft.symbol ?? s.symbol })),
  requestFocus: (target) => set({ focus: { target, nonce: ++nonce } }),
  setCheatSheet: (cheatSheetOpen) => set({ cheatSheetOpen }),
}));

/** Imperative handle for code outside React (goal 07 copilot, tests): `terminalApi.prefillTicket(draft)`. */
export const terminalApi = {
  prefillTicket: (draft: TicketDraft) => useTerminal.getState().prefillTicket(draft),
  setSymbol: (symbol: string) => useTerminal.getState().setSymbol(symbol),
  getSymbol: () => useTerminal.getState().symbol,
};

/** Feed / socket state for the status bar (set by the terminal's market store). */
interface FeedState {
  feed: 'ok' | 'degraded' | 'down' | null;
  socket: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  tickP95: number | null;
  set: (p: Partial<Omit<FeedState, 'set'>>) => void;
}

export const useFeedState = create<FeedState>((set) => ({
  feed: null,
  socket: 'idle',
  tickP95: null,
  set: (p) => set(p),
}));
