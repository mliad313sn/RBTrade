'use client';

import {
  conditionLabel,
  numLabel,
  type BlockSection,
  type Condition,
  type StrategyDefinition,
} from '@kora/domain';
import { useState, type DragEvent, type ReactNode } from 'react';

/** Parameter names referenced anywhere inside a DSL piece. */
export function paramsIn(piece: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.param === 'string' && Object.keys(o).length === 1) out.add(o.param);
      else Object.values(o).forEach(walk);
    }
  };
  walk(piece);
  return [...out];
}

export function stopLabel(d: StrategyDefinition): string {
  const s = d.exit.stop;
  return s.kind === 'atr'
    ? `Stop ${numLabel(s.multiple, d.params)} × ATR(${numLabel(s.period, d.params)})`
    : `Stop ${numLabel(s.pct, d.params)}%`;
}

export function targetLabel(d: StrategyDefinition): string | null {
  const t = d.exit.target;
  if (!t) return null;
  if (t.kind === 'atr') return `Target ${numLabel(t.multiple, d.params)} × ATR`;
  if (t.kind === 'r') return `Target ${numLabel(t.multiple, d.params)} R`;
  return `Target ${numLabel(t.pct, d.params)}%`;
}

export function sizeLabel(d: StrategyDefinition): string {
  const z = d.size;
  const max = `max ${z.maxOpenPositions} open`;
  if (z.kind === 'risk_pct') return `Risk ${numLabel(z.pct, d.params)}% equity / trade · ${max}`;
  if (z.kind === 'fixed') return `Fixed ${z.qty} · ${max}`;
  return `Vol target ${numLabel(z.annualVolPct, d.params)}% · ${max}`;
}

interface ChipSpec {
  section: BlockSection;
  index: number;
  label: string;
  piece: unknown;
  ai?: boolean;
  removable: boolean;
}

function chips(d: StrategyDefinition): Record<'entry' | 'filter' | 'exit' | 'size', ChipSpec[]> {
  const cond = (c: Condition, section: BlockSection, index: number): ChipSpec => ({
    section,
    index,
    label: conditionLabel(c, d.params),
    piece: c,
    ai: c.type === 'ai_regime',
    removable: true,
  });
  const exit: ChipSpec[] = [
    { section: 'stop', index: 0, label: stopLabel(d), piece: d.exit.stop, removable: false },
  ];
  const tl = targetLabel(d);
  if (tl)
    exit.push({ section: 'target', index: 0, label: tl, piece: d.exit.target, removable: true });
  if (d.exit.trailing)
    exit.push({
      section: 'trailing',
      index: 0,
      label: `Trail after ${numLabel(d.exit.trailing.afterR, d.params)}R`,
      piece: d.exit.trailing,
      removable: true,
    });
  if (d.exit.timeStopBars !== undefined)
    exit.push({
      section: 'time_stop',
      index: 0,
      label: `Time stop ${numLabel(d.exit.timeStopBars, d.params)} bars`,
      piece: d.exit.timeStopBars,
      removable: true,
    });
  d.exit.conditions.forEach((c, i) =>
    exit.push({ ...cond(c, 'exit_condition', i), label: `Exit if ${conditionLabel(c, d.params)}` }),
  );
  return {
    entry: d.entry.conditions.map((c, i) => cond(c, 'entry', i)),
    filter: d.filters.map((c, i) => cond(c, 'filter', i)),
    exit,
    size: [{ section: 'size', index: 0, label: sizeLabel(d), piece: d.size, removable: false }],
  };
}

const ROWS: Array<{
  key: 'entry' | 'filter' | 'exit' | 'size';
  tag: string;
  joiner?: string;
  tone: string;
  drop: BlockSection[];
}> = [
  { key: 'entry', tag: 'ENTRY', joiner: 'AND', tone: 'var(--k-up)', drop: ['entry'] },
  { key: 'filter', tag: 'FILTER', joiner: 'AND', tone: 'var(--k-text-muted)', drop: ['filter'] },
  {
    key: 'exit',
    tag: 'EXIT',
    tone: 'var(--k-down)',
    drop: ['stop', 'target', 'trailing', 'time_stop', 'exit_condition'],
  },
  { key: 'size', tag: 'SIZE', tone: 'var(--k-text)', drop: ['size'] },
];

export interface BlockChipsProps {
  definition: StrategyDefinition;
  editable?: boolean;
  onParamChange?: (name: string, value: number) => void;
  onRemove?: (section: BlockSection, index: number) => void;
  /** Called with the section of the row a block was dropped on (the builder picks the exact section). */
  onDrop?: (row: 'entry' | 'filter' | 'exit' | 'size', blockId: string) => void;
  extra?: ReactNode;
}

/** The prototype's rule chips: ENTRY / FILTER / EXIT / SIZE rows; editable in the builder. */
export function BlockChips({
  definition,
  editable = false,
  onParamChange,
  onRemove,
  onDrop,
  extra,
}: BlockChipsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const c = chips(definition);
  const dropProps = (row: (typeof ROWS)[number]['key']) =>
    editable && onDrop
      ? {
          onDragOver: (e: DragEvent) => {
            e.preventDefault();
            setOver(row);
          },
          onDragLeave: () => setOver(null),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            setOver(null);
            const id = e.dataTransfer.getData('text/x-kora-block');
            if (id) onDrop(row, id);
          },
        }
      : {};
  return (
    <div className="flex flex-col gap-2" data-testid="block-chips">
      {ROWS.map((row) => {
        const list = c[row.key];
        if (!editable && !list.length) return null;
        return (
          <div
            key={row.key}
            className="flex flex-wrap items-center gap-2 rounded p-1"
            style={over === row.key ? { outline: '1px dashed var(--k-accent)' } : undefined}
            data-testid={`row-${row.key}`}
            {...dropProps(row.key)}
          >
            <span
              className="k-chip"
              style={{
                color: row.tone,
                borderColor: row.tone,
                background: 'transparent',
                minWidth: 58,
                justifyContent: 'center',
              }}
            >
              {row.tag}
            </span>
            {list.map((chip, i) => {
              const id = `${chip.section}-${chip.index}`;
              const params = paramsIn(chip.piece);
              return (
                <span key={id} className="flex items-center gap-2">
                  {i > 0 && row.joiner ? (
                    <span className="text-xs font-semibold text-muted">{row.joiner}</span>
                  ) : null}
                  <span className="relative inline-flex items-center">
                    <button
                      type="button"
                      className="k-btn k-btn--sm k-num"
                      style={
                        chip.ai ? { color: 'var(--k-ai)', borderColor: 'var(--k-ai)' } : undefined
                      }
                      aria-expanded={editable && params.length ? open === id : undefined}
                      onClick={() => editable && params.length && setOpen(open === id ? null : id)}
                      data-testid={`chip-${id}`}
                    >
                      {chip.ai ? '✦ ' : ''}
                      {chip.label}
                    </button>
                    {editable && chip.removable && onRemove ? (
                      <button
                        type="button"
                        className="k-btn k-btn--sm k-btn--ghost"
                        aria-label={`Remove ${chip.label}`}
                        onClick={() => onRemove(chip.section, chip.index)}
                      >
                        ×
                      </button>
                    ) : null}
                    {editable && open === id ? (
                      <span
                        className="absolute left-0 top-full z-10 mt-1 flex min-w-56 flex-col gap-2 rounded border p-2"
                        style={{ background: 'var(--k-raised)', borderColor: 'var(--k-border)' }}
                        role="group"
                        aria-label={`Parameters of ${chip.label}`}
                      >
                        {params.map((name) => {
                          const spec = definition.params[name];
                          if (!spec) return null;
                          return (
                            <label key={name} className="k-field">
                              <span className="k-label">{spec.label ?? name}</span>
                              <input
                                className="k-input k-input--num"
                                type="number"
                                step={spec.step ?? (spec.integer ? 1 : 0.05)}
                                min={spec.min}
                                max={spec.max}
                                defaultValue={spec.value}
                                data-testid={`param-${name}`}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  if (e.target.value !== '' && Number.isFinite(v))
                                    onParamChange?.(name, v);
                                }}
                              />
                            </label>
                          );
                        })}
                        <button
                          type="button"
                          className="k-btn k-btn--sm"
                          onClick={() => setOpen(null)}
                        >
                          Done
                        </button>
                      </span>
                    ) : null}
                  </span>
                </span>
              );
            })}
            {editable && !list.length ? (
              <span className="text-xs text-muted">Drop a block here</span>
            ) : null}
          </div>
        );
      })}
      {extra}
    </div>
  );
}
