'use client';

import {
  addBlock,
  BLOCK_CATALOG,
  blankStrategy,
  removeBlock,
  STRATEGY_TEMPLATES,
  STRATEGY_TIMEFRAMES,
  type BlockCatalogEntry,
  type BlockSection,
  type StrategyDefinition,
  type StrategyIssue,
  type StrategyTimeframe,
} from '@kora/domain';
import { Banner, Button, Chip, Panel, Select, Tabs } from '@kora/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type DragEvent } from 'react';

import { RobotsApiError, robotsApi } from '@/lib/robots/client';
import type { StrategyDetail, ValidationResult } from '@/lib/robots/types';

import { BlockChips } from './BlockChips';

const GROUPS: Array<{ title: string; match: (b: BlockCatalogEntry) => boolean }> = [
  {
    title: 'Conditions',
    match: (b) => b.sections.includes('entry') || b.sections.includes('filter'),
  },
  {
    title: 'Exit',
    match: (b) =>
      ['stop', 'target', 'trailing', 'time_stop'].some((s) =>
        b.sections.includes(s as BlockSection),
      ),
  },
  { title: 'Size', match: (b) => b.sections.includes('size') },
];

/** Where a block lands when dropped on a row (or added with its button). */
function sectionFor(
  block: BlockCatalogEntry,
  row: 'entry' | 'filter' | 'exit' | 'size' | null,
): BlockSection | null {
  if (row === null) return block.sections[0] ?? null;
  if (row === 'exit') {
    const s = block.sections.find((x) =>
      ['stop', 'target', 'trailing', 'time_stop', 'exit_condition'].includes(x),
    );
    return s ?? null;
  }
  return block.sections.includes(row) ? row : null;
}

/**
 * Visual strategy builder (goal 06 §2): drag blocks onto ENTRY / FILTER / EXIT / SIZE, edit their
 * parameters inline, see validation live, switch to the JSON view (quants), import/export. Saving
 * creates an immutable, content-hashed version with a reason.
 */
export function StrategyBuilder() {
  const router = useRouter();
  const search = useSearchParams();
  const editId = search.get('strategy');
  const template = search.get('template');
  // Goal 07B "Send to Robot builder": the Market Radar passes the instrument to trade.
  const fromRadar =
    search
      .get('symbol')
      ?.toUpperCase()
      .replace(/[^A-Z0-9._-]/g, '')
      .slice(0, 32) || null;
  const [def, setDef] = useState<StrategyDefinition>(() => {
    const t = STRATEGY_TEMPLATES.find((x) => x.id === template);
    const d = t ? structuredClone(t.definition) : blankStrategy('New strategy', ['BTCUSD'], '1h');
    if (fromRadar) d.universe.symbols = [fromRadar];
    return d;
  });
  const [base, setBase] = useState<StrategyDetail | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [symbolsText, setSymbolsText] = useState(def.universe.symbols.join(', '));
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editId) return;
    void robotsApi
      .strategy(editId)
      .then((s) => {
        setBase(s);
        const d = s.versions[0]!.definition;
        setDef(structuredClone(d));
        setSymbolsText(d.universe.symbols.join(', '));
      })
      .catch((e: Error) => setError(e.message));
  }, [editId]);

  useEffect(() => {
    setJson(JSON.stringify(def, null, 2));
    const t = setTimeout(() => {
      void robotsApi
        .validate(def)
        .then(setValidation)
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [def]);

  const apply = (next: StrategyDefinition) => {
    setDef(next);
    setError(null);
  };
  const add = (id: string, row: 'entry' | 'filter' | 'exit' | 'size' | null) => {
    const block = BLOCK_CATALOG.find((b) => b.id === id);
    if (!block) return;
    const section = sectionFor(block, row);
    if (!section) {
      setError(`${block.label} cannot go into ${row?.toUpperCase() ?? 'that section'}.`);
      return;
    }
    apply(addBlock(def, id, section));
  };
  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.setData('text/x-kora-block', id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(json) as StrategyDefinition;
      setJsonError(null);
      apply(parsed);
      setSymbolsText((parsed.universe?.symbols ?? []).join(', '));
    } catch (e) {
      setJsonError(`Not valid JSON: ${(e as Error).message}`);
    }
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${def.name.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase() || 'strategy'}.kora-strategy.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as StrategyDefinition;
      apply(parsed);
      setSymbolsText((parsed.universe?.symbols ?? []).join(', '));
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = base
        ? await robotsApi.newVersion(base.id, def, reason.trim(), base.versions[0]!.id)
        : await robotsApi.createStrategy(def, reason.trim() || 'Initial version');
      const { robots } = await robotsApi.robots();
      const robot = robots.find((r) => r.strategyId === saved.id);
      router.push(robot ? `/robots?robot=${robot.id}` : `/robots?strategy=${saved.id}`);
    } catch (e) {
      setError(e instanceof RobotsApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = validation?.issues.filter((i) => i.severity === 'warning') ?? [];
  const canSave = !!validation?.valid && (!base || reason.trim().length >= 3) && !saving;

  return (
    <div className="flex flex-col gap-2">
      <header className="flex flex-wrap items-center gap-3 px-1">
        <h1 className="m-0 text-lg font-semibold">Robot builder</h1>
        <p className="m-0 text-sm text-muted">
          {base
            ? `Editing ${base.name} (v${base.latestVersion}): saving creates v${base.latestVersion + 1}`
            : 'Rules as blocks, versioned and hashed'}
        </p>
        <Chip tone="paper">PAPER</Chip>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            label="Start from"
            hideLabel
            value=""
            onChange={(e) => {
              const t = STRATEGY_TEMPLATES.find((x) => x.id === e.target.value);
              if (t) {
                apply(structuredClone(t.definition));
                setSymbolsText(t.definition.universe.symbols.join(', '));
              } else if (e.target.value === 'blank') {
                const b = blankStrategy(def.name, def.universe.symbols, def.universe.timeframe);
                apply(b);
              }
            }}
            options={[
              { value: '', label: 'Start from…' },
              { value: 'blank', label: 'Blank' },
              ...STRATEGY_TEMPLATES.map((t) => ({ value: t.id, label: `Template: ${t.name}` })),
            ]}
            data-testid="start-from"
          />
          <Button size="sm" onClick={exportJson} data-testid="export-json">
            Export
          </Button>
          <Button size="sm" onClick={() => fileRef.current?.click()} data-testid="import-json">
            Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="k-sr-only"
            aria-label="Import a strategy JSON file"
            onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])}
          />
        </div>
      </header>
      {error ? (
        <div data-testid="builder-error">
          <Banner tone="critical">{error}</Banner>
        </div>
      ) : null}
      <div className="grid gap-2 xl:grid-cols-[250px_minmax(0,1fr)_300px]">
        <Panel title="Blocks" data-testid="palette">
          <p className="mt-0 text-xs text-muted">Drag a block onto a row, or use its + button.</p>
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-3">
              <h3 className="mb-1 mt-0 text-xs font-semibold uppercase text-muted">{g.title}</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {BLOCK_CATALOG.filter(g.match).map((b) => (
                  <li
                    key={b.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, b.id)}
                    className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm"
                    style={{ borderColor: 'var(--k-border)', cursor: 'grab' }}
                    data-testid={`block-${b.id}`}
                    title={b.description}
                  >
                    <span>
                      {b.id === 'ai_regime' ? '✦ ' : ''}
                      {b.label}
                    </span>
                    <button
                      type="button"
                      className="k-btn k-btn--sm"
                      aria-label={`Add ${b.label}`}
                      onClick={() => add(b.id, null)}
                      data-testid={`add-${b.id}`}
                    >
                      +
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Panel>

        <div className="flex min-w-0 flex-col gap-2">
          <Panel title="Strategy">
            <div className="grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_100px_90px_110px]">
              <label className="k-field">
                <span className="k-label">Name</span>
                <input
                  className="k-input"
                  value={def.name}
                  onChange={(e) => apply({ ...def, name: e.target.value })}
                  data-testid="strategy-name-input"
                />
              </label>
              <label className="k-field">
                <span className="k-label">Instruments (registry symbols)</span>
                <input
                  className="k-input"
                  value={symbolsText}
                  onChange={(e) => setSymbolsText(e.target.value)}
                  onBlur={() =>
                    apply({
                      ...def,
                      universe: {
                        ...def.universe,
                        symbols: symbolsText
                          .split(/[\s,]+/)
                          .map((s) => s.trim().toUpperCase())
                          .filter(Boolean),
                      },
                    })
                  }
                  data-testid="symbols-input"
                />
              </label>
              <Select
                label="Timeframe"
                value={def.universe.timeframe}
                onChange={(e) =>
                  apply({
                    ...def,
                    universe: { ...def.universe, timeframe: e.target.value as StrategyTimeframe },
                  })
                }
                options={STRATEGY_TIMEFRAMES.map((t) => ({ value: t, label: t }))}
                data-testid="timeframe"
              />
              <label className="k-field">
                <span className="k-label">Max open</span>
                <input
                  className="k-input k-input--num"
                  type="number"
                  min={1}
                  max={20}
                  value={def.size.maxOpenPositions}
                  onChange={(e) => {
                    const n = Math.max(1, Math.min(20, Math.trunc(Number(e.target.value) || 1)));
                    apply({ ...def, size: { ...def.size, maxOpenPositions: n } });
                  }}
                  data-testid="max-open"
                />
              </label>
              <Select
                label="Side"
                value={def.entry.side}
                onChange={(e) =>
                  apply({
                    ...def,
                    entry: { ...def.entry, side: e.target.value as 'long' | 'short' },
                  })
                }
                options={[
                  { value: 'long', label: 'Long' },
                  { value: 'short', label: 'Short' },
                ]}
                data-testid="side"
              />
            </div>
          </Panel>
          <Tabs
            label="Builder view"
            items={[
              {
                value: 'blocks',
                label: 'Blocks',
                content: (
                  <Panel title="Rules" className="mt-2">
                    <BlockChips
                      definition={def}
                      editable
                      onParamChange={(name, value) =>
                        apply({
                          ...def,
                          params: { ...def.params, [name]: { ...def.params[name]!, value } },
                        })
                      }
                      onRemove={(section, index) => apply(removeBlock(def, section, index))}
                      onDrop={(row, id) => add(id, row)}
                    />
                  </Panel>
                ),
              },
              {
                value: 'json',
                label: 'View as JSON',
                content: (
                  <Panel
                    title="kora.strategy v1 (JSON)"
                    className="mt-2"
                    actions={
                      <Button size="sm" onClick={applyJson} data-testid="apply-json">
                        Apply JSON
                      </Button>
                    }
                  >
                    <textarea
                      className="k-input k-num w-full"
                      style={{ minHeight: 420, padding: 8, lineHeight: 1.4 }}
                      value={json}
                      onChange={(e) => setJson(e.target.value)}
                      spellCheck={false}
                      aria-label="Strategy JSON"
                      data-testid="json-editor"
                    />
                    {jsonError ? <p className="k-error">{jsonError}</p> : null}
                  </Panel>
                ),
              },
            ]}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Panel title="Validation" data-testid="validation">
            {!validation ? (
              <p className="text-sm text-muted">Checking…</p>
            ) : (
              <>
                <p
                  className="mt-0 text-sm"
                  data-testid="validation-state"
                  style={{ color: validation.valid ? 'var(--k-up)' : 'var(--k-kill)' }}
                >
                  {validation.valid
                    ? '✓ Valid'
                    : `✗ ${errors.length} error${errors.length === 1 ? '' : 's'}`}
                  {validation.shortHash ? (
                    <span className="k-num ml-2 text-muted">params {validation.shortHash}</span>
                  ) : null}
                </p>
                <IssueList issues={errors} tone="var(--k-kill)" icon="✗" />
                <IssueList issues={warnings} tone="var(--k-warn)" icon="⚠" />
                {validation.warmupBars ? (
                  <p className="mb-0 text-xs text-muted">
                    Warm-up: {validation.warmupBars} bars before the first signal.
                  </p>
                ) : null}
              </>
            )}
          </Panel>
          <Panel title="Save">
            {base ? (
              <label className="k-field">
                <span className="k-label">Why did it change? (required)</span>
                <input
                  className="k-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. ATR stop 1.5 → 1.4"
                  data-testid="version-reason"
                />
              </label>
            ) : null}
            <p className="text-xs text-muted">
              Every version is immutable and gets a content hash. Parameter changes are audit-logged
              with your name and reason.
            </p>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={!canSave}
              data-testid="save-strategy"
              className="k-btn--block"
            >
              {saving ? 'Saving…' : base ? `Save as v${base.latestVersion + 1}` : 'Save strategy'}
            </Button>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function IssueList({
  issues,
  tone,
  icon,
}: {
  issues: StrategyIssue[];
  tone: string;
  icon: string;
}) {
  if (!issues.length) return null;
  return (
    <ul className="m-0 mb-2 flex list-none flex-col gap-1 p-0 text-xs">
      {issues.map((i) => (
        <li key={`${i.path}-${i.message}`} style={{ color: tone }}>
          {icon} {i.message}
          {i.path ? <span className="text-muted"> ({i.path})</span> : null}
        </li>
      ))}
    </ul>
  );
}
