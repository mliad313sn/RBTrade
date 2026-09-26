import type { DockviewApi, SerializedDockview } from 'dockview-react';

/**
 * Pro terminal layout (goal 04). Default = the prototype grid at 1440×900: watchlist (2 of 12
 * columns) over the economic calendar, chart (7), order book | time & sales over the ticket (3),
 * and the full-width blotter (Positions, Orders, Fills, Alerts, Risk as tabs). Every panel can be
 * dragged, docked, tabbed or resized; named layouts are saved per user (api) and the working
 * layout is kept in localStorage.
 */

export const PANEL_IDS = ['watchlist', 'calendar', 'chart', 'orderbook', 'trades', 'ticket', 'positions', 'orders', 'fills', 'alerts', 'risk'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const PANEL_TITLES: Record<PanelId, string> = {
  watchlist: 'Watchlist',
  calendar: 'Economic calendar · UTC',
  chart: 'Chart',
  orderbook: 'Order book · Depth',
  trades: 'Time & sales',
  ticket: 'Order ticket',
  positions: 'Positions',
  orders: 'Orders',
  fills: 'Fills',
  alerts: 'Alerts',
  risk: 'Risk',
};

/** Alt+1..5 targets. */
export const FOCUS_PANELS: Record<'watchlist' | 'chart' | 'orderbook' | 'ticket' | 'blotter', PanelId> = {
  watchlist: 'watchlist',
  chart: 'chart',
  orderbook: 'orderbook',
  ticket: 'ticket',
  blotter: 'positions',
};

const LOCAL_KEY = 'kora.terminal.layout.v1';
export const LOCAL_ACTIVE_KEY = 'kora.terminal.layout.active';

/** Column widths at a given content width: 2 / 7 / 3 of 12 with 8 px gaps (prototype: 225 / 798 / 340 at 1440). */
export function defaultSizes(width: number, height: number): { left: number; right: number; blotter: number; calendar: number; orderbook: number } {
  const usable = Math.max(0, width - 16);
  const col = usable / 12;
  return {
    left: Math.round(col * 2),
    right: Math.round(col * 3),
    // Prototype: 186 px blotter at 900 px; 240 px (spec) once the viewport is tall enough.
    blotter: height >= 1000 ? 240 : Math.max(160, Math.round(height * 0.225)),
    calendar: 90,
    orderbook: Math.round(Math.max(200, height * 0.3)),
  };
}

export function buildDefaultLayout(api: DockviewApi): void {
  api.clear();
  const w = api.width || 1392;
  const h = api.height || 836;
  const s = defaultSizes(w, h);
  api.addPanel({ id: 'chart', component: 'chart', title: PANEL_TITLES.chart });
  api.addPanel({ id: 'positions', component: 'positions', title: PANEL_TITLES.positions, position: { direction: 'below' }, initialHeight: s.blotter });
  for (const id of ['orders', 'fills', 'alerts', 'risk'] as const) {
    api.addPanel({ id, component: id, title: PANEL_TITLES[id], position: { referencePanel: 'positions', direction: 'within' }, inactive: true });
  }
  api.addPanel({ id: 'watchlist', component: 'watchlist', title: PANEL_TITLES.watchlist, position: { referencePanel: 'chart', direction: 'left' }, initialWidth: s.left });
  api.addPanel({ id: 'calendar', component: 'calendar', title: PANEL_TITLES.calendar, position: { referencePanel: 'watchlist', direction: 'below' }, initialHeight: s.calendar });
  api.addPanel({ id: 'orderbook', component: 'orderbook', title: PANEL_TITLES.orderbook, position: { referencePanel: 'chart', direction: 'right' }, initialWidth: s.right });
  api.addPanel({ id: 'trades', component: 'trades', title: PANEL_TITLES.trades, position: { referencePanel: 'orderbook', direction: 'within' }, inactive: true });
  api.addPanel({ id: 'ticket', component: 'ticket', title: PANEL_TITLES.ticket, position: { referencePanel: 'orderbook', direction: 'below' }, initialHeight: h - s.blotter - s.orderbook - 16 });
  // Explicit sizes (initial sizes are hints when groups are split later).
  api.getPanel('watchlist')?.group.api.setSize({ width: s.left });
  api.getPanel('orderbook')?.group.api.setSize({ width: s.right, height: s.orderbook });
  api.getPanel('calendar')?.group.api.setSize({ height: s.calendar });
  api.getPanel('positions')?.group.api.setSize({ height: s.blotter });
  api.getPanel('positions')?.api.setActive();
  api.getPanel('chart')?.api.setActive();
}

/** Panel ids placed in the grid's groups (leaf `data.views`) of a serialized dockview layout. */
function placedViews(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: string; data?: unknown };
  if (n.type === 'leaf') {
    const views = (n.data as { views?: unknown })?.views;
    if (Array.isArray(views)) out.push(...views.filter((v): v is string => typeof v === 'string'));
  } else if (Array.isArray(n.data)) {
    for (const child of n.data) placedViews(child, out);
  }
  return out;
}

/**
 * True if a serialized layout places every panel exactly once in its grid (floating groups count
 * too). Older, partial or foreign JSON is rejected and the default layout is built instead.
 */
export function isCompleteLayout(json: unknown): json is SerializedDockview {
  if (!json || typeof json !== 'object') return false;
  const j = json as { panels?: Record<string, unknown>; grid?: { root?: unknown }; floatingGroups?: Array<{ data?: { views?: unknown } }> };
  if (!j.panels || typeof j.panels !== 'object' || !j.grid) return false;
  const ids = Object.keys(j.panels);
  if (!(PANEL_IDS.every((id) => ids.includes(id)) && ids.every((id) => (PANEL_IDS as readonly string[]).includes(id)))) return false;
  const placed = placedViews(j.grid.root);
  for (const f of j.floatingGroups ?? []) if (Array.isArray(f.data?.views)) placed.push(...(f.data.views as string[]));
  return PANEL_IDS.every((id) => placed.filter((v) => v === id).length === 1);
}

export function loadLocalLayout(): SerializedDockview | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const json = JSON.parse(raw) as unknown;
    return isCompleteLayout(json) ? json : null;
  } catch {
    return null;
  }
}

export function saveLocalLayout(json: SerializedDockview): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(json));
  } catch {
    /* storage unavailable (private window): the layout still works for this session */
  }
}

export function clearLocalLayout(): void {
  try {
    window.localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}
