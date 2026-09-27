'use client';

import {
  atr,
  bollinger,
  dec,
  ema,
  INDICATOR_DEFAULTS,
  roundToTick,
  rsi,
  sma,
  TIMEFRAME_SECONDS,
  vwapSeries,
  type IndicatorId,
  type OhlcvBar,
  type OrderDto,
  type Timeframe,
} from '@kora/domain';
import { Button, Dialog, formatPercent, formatPrice, useToast } from '@kora/ui';
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { api } from '@/lib/api-browser';
import { safeLocale } from '@/lib/terminal/format';
import { useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';
import { refreshTrading, useTrading } from '@/lib/terminal/trading';
import { orderLine } from '@/lib/terminal/views';

import { SessionBadge } from '../Badges';
import { useMarket } from '../TerminalContext';
import { AiStrip } from './AiStrip';

export const CHART_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D'];
const HISTORY_BARS = 300;
const IND_KEY = 'kora.terminal.indicators';
const DRAW_KEY = (s: string) => `kora.terminal.drawings.${s}`;

interface Bar extends OhlcvBar {
  open: number;
}
interface Drawings {
  h: number[];
  t: Array<{ t1: number; p1: number; t2: number; p2: number }>;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette() {
  return {
    up: cssVar('--k-up', '#4DA3FF'),
    down: cssVar('--k-down', '#FF9F40'),
    panel: cssVar('--k-panel', '#11151C'),
    border: cssVar('--k-border', '#262E3B'),
    muted: cssVar('--k-text-muted', '#9AA4B2'),
    text: cssVar('--k-text', '#E6EAF0'),
    ai: cssVar('--k-ai', '#A78BFA'),
    warn: cssVar('--k-warn', '#F2C94C'),
    accent: cssVar('--k-accent', '#4DA3FF'),
  };
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const line = (values: Array<number | null>, bars: Bar[]) =>
  values.flatMap((v, i) => (v === null || !Number.isFinite(v) ? [] : [{ time: toTime(bars[i]!.t), value: v }]));

/**
 * Chart panel (goal 04): lightweight-charts candles on 1m–1D, volume, indicators from the shared
 * `@kora/domain` library, drawing tools, own fills as markers, working orders as draggable price
 * lines (drag or arrow keys, then confirm → PATCH /orders/:id), last price tag and a crosshair
 * OHLC readout. The AI strip (goal 07 slot) sits under the chart.
 */
export function ChartPanel({ aiStrip }: { aiStrip: 'off' | 'placeholder' | 'on' }) {
  const store = useMarket();
  const toast = useToast();
  const symbol = useTerminal((s) => s.symbol);
  const tf = useTerminal((s) => s.timeframe);
  const setTf = useTerminal((s) => s.setTimeframe);
  const spec = useRegistry((s) => s.instruments.get(symbol));
  const orders = useTrading((s) => s.orders);
  const fills = useTrading((s) => s.fills);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const indRef = useRef(new Map<string, ISeriesApi<'Line'>>());
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const orderLinesRef = useRef(new Map<string, IPriceLine>());
  const hLinesRef = useRef<IPriceLine[]>([]);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const lastRef = useRef<HTMLSpanElement>(null);
  const chgRef = useRef<HTMLSpanElement>(null);
  const [indicators, setIndicators] = useState<IndicatorId[]>(() => loadJson<IndicatorId[]>(IND_KEY, ['ema', 'vwap']));
  const [drawMode, setDrawMode] = useState<'none' | 'hline' | 'trend'>('none');
  const [drawings, setDrawings] = useState<Drawings>({ h: [], t: [] });
  const [pendingTrend, setPendingTrend] = useState<{ t: number; p: number } | null>(null);
  const [handles, setHandles] = useState<Array<{ id: string; y: number; label: string; side: 'buy' | 'sell'; draggable: boolean }>>([]);
  const [drag, setDrag] = useState<{ id: string; price: string } | null>(null);
  const [amend, setAmend] = useState<{ order: OrderDto; field: 'limitPrice' | 'stopPrice'; from: string; to: string } | null>(null);
  const [lastPrice, setLastPrice] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const dayOpen = useRef<string | null>(null);
  /** Prices that must stay visible (working orders, drawn lines): folded into the autoscale range. */
  const keepVisible = useRef<number[]>([]);
  const precision = spec?.pricePrecision ?? 5;
  const tick = spec?.tickSize ?? '0.00001';

  const symbolOrders = useMemo(() => orders.filter((o) => o.symbol === symbol && orderLine(o)), [orders, symbol]);

  // ---- chart lifecycle ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = palette();
    const chart = createChart(host, {
      autoSize: true,
      // IRTC R5-18: never hand an invalid browser tag ("en-US@posix") to the chart's Intl formatters.
      localization: { locale: safeLocale(typeof navigator === 'undefined' ? undefined : navigator.language) },
      layout: { background: { color: c.panel }, textColor: c.muted, fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: 11, panes: { separatorColor: c.border } },
      grid: { vertLines: { color: 'rgba(38,46,59,0.35)' }, horzLines: { color: 'rgba(38,46,59,0.35)' } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderUpColor: c.up,
      borderDownColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
      priceLineColor: c.accent,
      priceLineStyle: LineStyle.Dotted,
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const r = original();
        const extra = keepVisible.current;
        if (!r?.priceRange || extra.length === 0) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra), maxValue: Math.max(r.priceRange.maxValue, ...extra) } };
      },
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candlesRef.current = candles;
    volRef.current = vol;
    markersRef.current = createSeriesMarkers(candles, []);

    const recolor = () => {
      const p = palette();
      candles.applyOptions({ upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down });
      setDataVersion((v) => v + 1);
    };
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-colors', 'data-theme'] });
    const ind = indRef.current;
    const orderLines = orderLinesRef.current;
    return () => {
      mo.disconnect();
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volRef.current = null;
      markersRef.current = null;
      ind.clear();
      orderLines.clear();
      hLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    candlesRef.current?.applyOptions({ priceFormat: { type: 'price', precision, minMove: Number(tick) } });
  }, [precision, tick]);

  // ---- overlay layout (order handles, trendlines) ----
  const layoutOverlay = useCallback(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return;
    const hs = symbolOrders.flatMap((o) => {
      const l = orderLine(o)!;
      const price = drag?.id === o.id ? drag.price : l.price;
      const y = candles.priceToCoordinate(Number(price));
      if (y === null) return [];
      const kind = o.role === 'stop_loss' ? 'SL' : o.role === 'take_profit' ? 'TP' : o.execType === 'limit' ? 'LMT' : o.execType === 'trailing' ? 'TRL' : 'STP';
      return [{ id: o.id, y, label: `${o.side === 'buy' ? 'BUY' : 'SELL'} ${kind} ${formatPrice(price, precision)}`, side: o.side, draggable: l.draggable }];
    });
    setHandles(hs);
    const svg = overlayRef.current;
    if (svg) {
      const ts = chart.timeScale();
      const parts = drawings.t.map((d) => {
        const x1 = ts.timeToCoordinate(toTime(d.t1));
        const x2 = ts.timeToCoordinate(toTime(d.t2));
        const y1 = candles.priceToCoordinate(d.p1);
        const y2 = candles.priceToCoordinate(d.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) return '';
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${palette().warn}" stroke-width="1.5" />`;
      });
      svg.innerHTML = parts.join('');
    }
  }, [symbolOrders, drag, drawings, precision]);
  const layoutRef = useRef(layoutOverlay);
  layoutRef.current = layoutOverlay;

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = () => layoutRef.current();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(onRange);
    if (hostRef.current) ro.observe(hostRef.current);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      ro.disconnect();
    };
  }, []);

  // ---- indicators ----
  const applyIndicators = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const bars = barsRef.current;
    const closes = bars.map((b) => b.close);
    const p = palette();
    const want = new Map<string, { data: Array<{ time: UTCTimestamp; value: number }>; color: string; pane: 'price' | 'own'; dashed?: boolean }>();
    for (const id of indicators) {
      if (id === 'ema') want.set('ema', { data: line(ema(closes, INDICATOR_DEFAULTS.ema.period), bars), color: p.ai, pane: 'price' });
      if (id === 'sma') want.set('sma', { data: line(sma(closes, INDICATOR_DEFAULTS.sma.period), bars), color: p.warn, pane: 'price' });
      if (id === 'vwap') want.set('vwap', { data: line(vwapSeries(bars), bars), color: p.muted, pane: 'price', dashed: true });
      if (id === 'bollinger') {
        const bb = bollinger(closes, INDICATOR_DEFAULTS.bollinger.period, 2);
        want.set('bb-u', { data: line(bb.upper, bars), color: p.muted, pane: 'price' });
        want.set('bb-m', { data: line(bb.middle, bars), color: p.muted, pane: 'price', dashed: true });
        want.set('bb-l', { data: line(bb.lower, bars), color: p.muted, pane: 'price' });
      }
      if (id === 'rsi') want.set('rsi', { data: line(rsi(closes, INDICATOR_DEFAULTS.rsi.period), bars), color: p.ai, pane: 'own' });
      if (id === 'atr') want.set('atr', { data: line(atr(bars, INDICATOR_DEFAULTS.atr.period), bars), color: p.warn, pane: 'own' });
    }
    for (const [key, s] of indRef.current) {
      if (!want.has(key)) {
        chart.removeSeries(s);
        indRef.current.delete(key);
      }
    }
    // Remove empty panes beyond the price pane.
    for (let i = chart.panes().length - 1; i >= 1; i--) if (chart.panes()[i]!.getSeries().length === 0) chart.removePane(i);
    for (const [key, w] of want) {
      let s = indRef.current.get(key);
      if (!s) {
        const pane = w.pane === 'price' ? 0 : chart.panes().length;
        s = chart.addSeries(LineSeries, { color: w.color, lineWidth: 1, lineStyle: w.dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: w.pane === 'own', crosshairMarkerVisible: false }, pane);
        indRef.current.set(key, s);
      }
      s.setData(w.data);
    }
  }, [indicators]);
  const applyIndRef = useRef(applyIndicators);
  applyIndRef.current = applyIndicators;

  useEffect(() => {
    saveJson(IND_KEY, indicators);
    applyIndicators();
  }, [indicators, applyIndicators]);

  // ---- data: history + live candles ----
  useEffect(() => {
    const candles = candlesRef.current;
    const vol = volRef.current;
    if (!candles || !vol) return;
    let cancelled = false;
    barsRef.current = [];
    candles.setData([]);
    vol.setData([]);
    setLastPrice(null);
    const p = palette();
    const volBar = (b: Bar) => ({ time: toTime(b.t), value: b.volume, color: `${b.close >= b.open ? p.up : p.down}66` });
    let lastInd = 0;
    const upsert = (b: Bar) => {
      const bars = barsRef.current;
      const last = bars[bars.length - 1];
      if (last && b.t < last.t) return;
      if (last && last.t === b.t) bars[bars.length - 1] = b;
      else bars.push(b);
      candles.update({ time: toTime(b.t), open: b.open, high: b.high, low: b.low, close: b.close });
      vol.update(volBar(b));
      const now = Date.now();
      if (now - lastInd > 1000) {
        lastInd = now;
        applyIndRef.current();
      }
      layoutRef.current();
    };
    void api
      .candles({ symbol, tf, limit: HISTORY_BARS })
      .then((r) => {
        if (cancelled) return;
        const bars: Bar[] = r.candles.map((c) => ({ t: c.t, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) }));
        barsRef.current = bars;
        candles.setData(bars.map((b) => ({ time: toTime(b.t), open: b.open, high: b.high, low: b.low, close: b.close })));
        vol.setData(bars.map(volBar));
        applyIndRef.current();
        chartRef.current?.timeScale().scrollToRealTime();
        setDataVersion((v) => v + 1);
      })
      .catch(() => undefined);
    const off = store.onCandle(symbol, tf, (c) => {
      if (cancelled) return;
      upsert({ t: c.bucket, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [store, symbol, tf]);

  // Header: last price, change vs day open, crosshair OHLC readout.
  useEffect(() => {
    dayOpen.current = null;
    void api
      .quotes([symbol])
      .then((r) => (dayOpen.current = r.quotes[0]?.dayOpen ?? null))
      .catch(() => undefined);
    return store.onQuote(symbol, (q) => {
      const mid = dec(q.bid).add(dec(q.ask)).div(2).toDecimalPlaces(precision).toFixed(precision);
      if (lastRef.current) lastRef.current.textContent = formatPrice(mid, precision);
      if (chgRef.current && dayOpen.current && !dec(dayOpen.current).isZero()) {
        const diff = dec(mid).sub(dec(dayOpen.current));
        const dir = diff.isZero() ? 'flat' : diff.isNegative() ? 'down' : 'up';
        chgRef.current.className = `ch-chg k-num k-dir--${dir}`;
        chgRef.current.textContent = `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''} ${diff.isNegative() ? '−' : '+'}${formatPrice(diff.abs().toFixed(), precision)} (${formatPercent(diff.div(dec(dayOpen.current)))})`;
      }
      setLastPrice((prev) => (prev === mid ? prev : mid));
    });
  }, [store, symbol, precision]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return;
    const show = (b: { open: number; high: number; low: number; close: number } | undefined) => {
      if (!readoutRef.current) return;
      readoutRef.current.textContent = b
        ? `O ${formatPrice(roundToTick(String(b.open), tick).toFixed(), precision)}  H ${formatPrice(roundToTick(String(b.high), tick).toFixed(), precision)}  L ${formatPrice(roundToTick(String(b.low), tick).toFixed(), precision)}  C ${formatPrice(roundToTick(String(b.close), tick).toFixed(), precision)}`
        : '';
    };
    const onMove = (param: MouseEventParams) => {
      const d = param.seriesData.get(candles) as { open: number; high: number; low: number; close: number } | undefined;
      show(d ?? barsRef.current.at(-1));
    };
    chart.subscribeCrosshairMove(onMove);
    show(barsRef.current.at(-1));
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [precision, tick, dataVersion]);

  // ---- fills as markers ----
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    const p = palette();
    const size = TIMEFRAME_SECONDS[tf];
    const own = fills
      .filter((f) => f.symbol === symbol)
      .map((f): SeriesMarker<Time> => {
        const t = Math.floor(Date.parse(f.ts) / 1000 / size) * size;
        return f.side === 'buy'
          ? { time: t as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: p.up, text: 'B' }
          : { time: t as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: p.down, text: 'S' };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
    m.setMarkers(own);
  }, [fills, symbol, tf, dataVersion]);

  // ---- working orders as price lines ----
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles) return;
    const p = palette();
    const lines = orderLinesRef.current;
    const seen = new Set<string>();
    keepVisible.current = [...symbolOrders.map((o) => Number(orderLine(o)!.price)), ...drawings.h];
    for (const o of symbolOrders) {
      const l = orderLine(o)!;
      const price = drag?.id === o.id ? drag.price : l.price;
      seen.add(o.id);
      const opts = { price: Number(price), color: o.side === 'buy' ? p.up : p.down, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' };
      const existing = lines.get(o.id);
      if (existing) existing.applyOptions(opts);
      else lines.set(o.id, candles.createPriceLine(opts));
    }
    for (const [id, pl] of lines) {
      if (!seen.has(id)) {
        candles.removePriceLine(pl);
        lines.delete(id);
      }
    }
    layoutOverlay();
  }, [symbolOrders, drag, layoutOverlay, dataVersion, drawings.h]);

  // ---- drawings ----
  useEffect(() => {
    setDrawings(loadJson<Drawings>(DRAW_KEY(symbol), { h: [], t: [] }));
    setPendingTrend(null);
  }, [symbol]);
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles) return;
    for (const pl of hLinesRef.current) candles.removePriceLine(pl);
    const p = palette();
    hLinesRef.current = drawings.h.map((price) => candles.createPriceLine({ price, color: p.warn, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '' }));
    layoutOverlay();
  }, [drawings, layoutOverlay, dataVersion]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles || drawMode === 'none') return;
    const onClick = (param: MouseEventParams) => {
      if (!param.point) return;
      const price = candles.coordinateToPrice(param.point.y);
      if (price === null) return;
      if (drawMode === 'hline') {
        const next = { ...drawings, h: [...drawings.h, price] };
        setDrawings(next);
        saveJson(DRAW_KEY(symbol), next);
        setDrawMode('none');
      } else if (param.time !== undefined) {
        const t = (param.time as number) * 1000;
        if (!pendingTrend) setPendingTrend({ t, p: price });
        else {
          const next = { ...drawings, t: [...drawings.t, { t1: pendingTrend.t, p1: pendingTrend.p, t2: t, p2: price }] };
          setDrawings(next);
          saveJson(DRAW_KEY(symbol), next);
          setPendingTrend(null);
          setDrawMode('none');
        }
      }
    };
    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [drawMode, drawings, pendingTrend, symbol]);

  // ---- dragging / keyboard amend of working orders ----
  const orderById = (id: string) => symbolOrders.find((o) => o.id === id);
  const priceAtY = (y: number): string | null => {
    const v = candlesRef.current?.coordinateToPrice(y);
    if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return null;
    return roundToTick(v.toFixed(Math.min(18, precision + 2)), tick).toFixed(precision);
  };
  const startAmend = (id: string, to: string) => {
    const o = orderById(id);
    if (!o) return;
    const l = orderLine(o)!;
    if (dec(to).eq(dec(l.price))) {
      setDrag(null);
      return;
    }
    setAmend({ order: o, field: l.field, from: l.price, to });
  };
  const onHandleDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const o = orderById(id);
    if (o) setDrag({ id, price: orderLine(o)!.price });
  };
  const onHandleMove = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (drag?.id !== id || !hostRef.current) return;
    const rect = hostRef.current.getBoundingClientRect();
    const price = priceAtY(e.clientY - rect.top);
    if (price) setDrag({ id, price });
  };
  const onHandleUp = (id: string) => {
    if (drag?.id === id) startAmend(id, drag.price);
  };
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const o = orderById(id);
    if (!o) return;
    const base = drag?.id === id ? drag.price : orderLine(o)!.price;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const steps = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const next = dec(base).add(dec(tick).mul(steps));
      if (next.gt(0)) setDrag({ id, price: next.toFixed(precision) });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      startAmend(id, base);
    } else if (e.key === 'Escape') {
      setDrag(null);
    }
  };
  const confirmAmend = async () => {
    if (!amend) return;
    try {
      await api.amendOrder(amend.order.id, { [amend.field]: amend.to });
      toast.push(`Order amended: ${amend.field === 'limitPrice' ? 'limit' : 'stop'} ${amend.from} → ${amend.to}.`, 'success', 4000);
      refreshTrading();
    } catch (e) {
      toast.push(`Amend refused: ${(e as Error).message}`, 'critical');
    } finally {
      setAmend(null);
      setDrag(null);
    }
  };

  const toggleIndicator = (id: IndicatorId) => setIndicators((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const clearDrawings = () => {
    const empty = { h: [], t: [] };
    setDrawings(empty);
    saveJson(DRAW_KEY(symbol), empty);
  };

  const name = spec?.displayName ?? symbol;
  const legend = indicators.map((id) => INDICATOR_DEFAULTS[id].label);

  return (
    <div className="ch flex flex-col h-full min-h-0" data-testid="chart-panel" data-panel-root="chart" tabIndex={-1}>
      <div className="ch-head">
        <h2 className="ch-sym" data-testid="chart-symbol">
          {name}
        </h2>
        <span ref={lastRef} className="ch-last k-num" data-testid="chart-last">
          —
        </span>
        <span ref={chgRef} className="ch-chg k-num" />
        <div className="ch-tfs" role="radiogroup" aria-label="Timeframe">
          {CHART_TIMEFRAMES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={tf === t} className={`ch-tf ${tf === t ? 'is-on' : ''}`} onClick={() => setTf(t)} data-testid={`tf-${t}`}>
              {t}
            </button>
          ))}
        </div>
        <details className="ch-menu">
          <summary aria-label="Indicators">
            <span aria-hidden="true">ƒx</span> Indicators
          </summary>
          <div className="ch-menu-pop" role="group" aria-label="Indicators">
            {(Object.keys(INDICATOR_DEFAULTS) as IndicatorId[]).map((id) => (
              <label key={id} className="flex items-center gap-2">
                <input type="checkbox" checked={indicators.includes(id)} onChange={() => toggleIndicator(id)} data-testid={`ind-${id}`} /> {INDICATOR_DEFAULTS[id].label}
              </label>
            ))}
          </div>
        </details>
        <details className="ch-menu">
          <summary aria-label="Drawing tools">
            <span aria-hidden="true">✎</span> Draw
          </summary>
          <div className="ch-menu-pop" role="group" aria-label="Drawing tools">
            <button type="button" className="ch-tf" aria-pressed={drawMode === 'hline'} onClick={() => setDrawMode(drawMode === 'hline' ? 'none' : 'hline')} data-testid="draw-hline">
              Horizontal line
            </button>
            <button type="button" className="ch-tf" aria-pressed={drawMode === 'trend'} onClick={() => setDrawMode(drawMode === 'trend' ? 'none' : 'trend')} data-testid="draw-trend">
              Trendline (2 clicks)
            </button>
            <button type="button" className="ch-tf" onClick={clearDrawings} data-testid="draw-clear">
              Clear drawings ({drawings.h.length + drawings.t.length})
            </button>
          </div>
        </details>
      </div>
      <div className="ch-legend">
        <span ref={readoutRef} className="ch-ohlc k-num" data-testid="chart-ohlc" aria-label="Candle open, high, low, close" />
        {legend.map((l) => (
          <span key={l}>— {l}</span>
        ))}
        <span>Vol</span>
        <span className="text-muted">Simulated feed · not market data</span>
        {spec ? <SessionBadge mic={spec.venue} state={spec.session?.state} className="ml-auto" /> : null}
        {drawMode !== 'none' ? <span className="text-warn">{drawMode === 'hline' ? 'Click to place a line' : pendingTrend ? 'Click the second point' : 'Click the first point'}</span> : null}
      </div>
      <div className="ch-canvas" role="group" aria-label={`${name} ${tf} candlestick chart${lastPrice ? `, last ${lastPrice}` : ''}. Your working orders are buttons on the right edge.`}>
        <div ref={hostRef} className="absolute inset-0" data-testid="chart-canvas" />
        <svg ref={overlayRef} className="ch-overlay" aria-hidden="true" />
        <div className="ch-handles">
          {handles.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`ch-handle ch-handle--${h.side}`}
              style={{ top: h.y }}
              aria-label={`${h.label}. ${h.draggable ? 'Drag or use arrow keys, then Enter to amend.' : 'Trailing stop (not draggable).'}`}
              data-testid={`order-line-${h.id}`}
              disabled={!h.draggable}
              onPointerDown={(e) => h.draggable && onHandleDown(e, h.id)}
              onPointerMove={(e) => onHandleMove(e, h.id)}
              onPointerUp={() => onHandleUp(h.id)}
              onKeyDown={(e) => onHandleKey(e, h.id)}
            >
              {h.label}
            </button>
          ))}
        </div>
      </div>
      {aiStrip !== 'off' ? <AiStrip mode={aiStrip} /> : null}
      <Dialog open={amend !== null} onOpenChange={(o) => !o && (setAmend(null), setDrag(null))} title="Amend working order?" description="Paper order. The engine re-checks risk and may fill at once if the new price is marketable." data-testid="confirm-amend">
        {amend ? (
          <p className="text-sm m-0">
            {amend.order.side === 'buy' ? 'Buy' : 'Sell'} {amend.order.qty} {amend.order.symbol}: {amend.field === 'limitPrice' ? 'limit' : 'stop'} {formatPrice(amend.from, precision)} → <strong>{formatPrice(amend.to, precision)}</strong>
          </p>
        ) : null}
        <div className="k-dialog__actions">
          <Button onClick={() => (setAmend(null), setDrag(null))}>Keep</Button>
          <Button variant="primary" onClick={() => void confirmAmend()} data-testid="confirm-amend-ok" autoFocus>
            Amend order
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
