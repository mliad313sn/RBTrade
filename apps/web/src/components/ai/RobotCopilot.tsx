'use client';

import './ai.css';

import type { StrategyDefinition } from '@kora/domain';
import { Button } from '@kora/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  aiApi,
  type AiAnswer,
  type NoEdgeScan,
  type RobotInsights,
  type SignalFeatures,
  type Suggestion,
} from '@/lib/ai/client';
import { robotsApi } from '@/lib/robots/client';

import { CopilotChat } from './CopilotChat';
import { FeatureChart } from './FeatureChart';

interface StrategyDraftView {
  id: string;
  changes: Array<{ param: string; from: number; to: number }>;
  baseVersion?: number;
}

/**
 * Robots copilot drawer (goal 07, `Robots.png`): why-panel (chart from stored features, explanation
 * streamed from the model), calibrated confidence with its reliability line, data-derived
 * suggestions that create UNAPPROVED drafts (only you save a version), the no-edge scan, and chat.
 */
export function RobotCopilot({
  robotId,
  strategyId,
  signalId: signalFromMonitor,
  onVersionSaved,
}: {
  robotId: string | null;
  strategyId: string | null;
  signalId: string | null;
  onVersionSaved?: () => void;
}) {
  const [insights, setInsights] = useState<RobotInsights | null>(null);
  const [features, setFeatures] = useState<SignalFeatures | null>(null);
  const [why, setWhy] = useState('');
  const [whyAnswer, setWhyAnswer] = useState<AiAnswer | null>(null);
  const [whyBusy, setWhyBusy] = useState(false);
  const [scan, setScan] = useState<NoEdgeScan | null>(null);
  const [draft, setDraft] = useState<StrategyDraftView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const signalId = signalFromMonitor ?? insights?.latestSignalId ?? null;

  useEffect(() => {
    setInsights(null);
    setDraft(null);
    setNotice(null);
    if (!robotId) return;
    aiApi
      .insights(robotId)
      .then(setInsights)
      .catch((e: Error) => setError(e.message));
  }, [robotId]);

  useEffect(() => {
    setFeatures(null);
    setWhy('');
    setWhyAnswer(null);
    if (!signalId) return;
    aiApi
      .features(signalId)
      .then(setFeatures)
      .catch(() => setFeatures(null));
  }, [signalId]);

  const explain = useCallback(async () => {
    if (!signalId) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setWhyBusy(true);
    setWhy('');
    setWhyAnswer(null);
    try {
      setWhyAnswer(await aiApi.why(signalId, (d) => setWhy((s) => s + d), ctrl.signal));
    } catch (e) {
      if ((e as Error).name !== 'AbortError')
        setWhyAnswer({ status: 'error', message: (e as Error).message });
    } finally {
      setWhyBusy(false);
    }
  }, [signalId]);

  async function createDraft(s: Suggestion) {
    if (!robotId || !s.draft) return;
    setNotice(null);
    try {
      const d = await aiApi.suggestionDraft(robotId, {
        param: s.draft.param,
        value: s.draft.to,
        rationale: s.title,
      });
      setDraft({ id: d.draftId, changes: d.summary.changes, baseVersion: d.summary.baseVersion });
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  /** The human saves the draft as a new version (their action, audited as them), then records the decision. */
  async function saveDraft() {
    if (!draft || !strategyId) return;
    try {
      const full = (await aiApi.draft(draft.id)) as {
        definition: StrategyDefinition;
        baseVersionId: string;
        rationale: string;
      };
      const saved = await robotsApi.newVersion(
        strategyId,
        full.definition,
        `Accepted copilot draft: ${full.rationale}`.slice(0, 300),
        full.baseVersionId,
      );
      if (saved.latest)
        await aiApi.decide(draft.id, { decision: 'accepted', versionId: saved.latest.id });
      setNotice(
        `Saved as v${saved.latestVersion}. The robot keeps its current version until you switch it.`,
      );
      setDraft(null);
      onVersionSaved?.();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function dismissDraft() {
    if (!draft) return;
    await aiApi.decide(draft.id, { decision: 'rejected' }).catch(() => undefined);
    setDraft(null);
    setNotice('Draft dismissed.');
  }

  const cal = insights?.calibration;
  const whyText = whyAnswer
    ? whyAnswer.status === 'ok'
      ? whyAnswer.answer
      : whyAnswer.message
    : why;
  return (
    <div className="ai-drawer flex flex-col gap-3" data-testid="robot-copilot">
      {error ? <p className="text-xs text-muted">{error}</p> : null}

      <section aria-labelledby="ai-why-h">
        <h3 id="ai-why-h" className="ai-drawer__h">
          {features
            ? `Why did ${insights?.name ?? 'the robot'} ${features.action.replace('enter_', 'go ').replace('_', ' ')} ${features.symbol} at ${features.barTs.slice(11, 16)}?`
            : 'Why did this trade happen?'}
        </h3>
        {features ? (
          <>
            <FeatureChart features={features} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void explain()}
              disabled={whyBusy}
              data-testid="why-explain"
            >
              {whyBusy ? 'Explaining…' : 'Explain in words'}
            </Button>
            {whyText ? (
              <div className="ai-drawer__text" aria-live="polite" data-testid="why-answer">
                {whyText.split('\n').map((l, i) => (l.trim() ? <p key={i}>{l}</p> : null))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted" data-testid="signal-features-empty">
            No signal yet.
          </p>
        )}
      </section>

      {cal ? (
        <section className="ai-drawer__grid" aria-label="Confidence">
          <div className="ai-drawer__box" data-testid="robot-confidence">
            <h3 className="ai-drawer__h">Confidence</h3>
            {cal.confidence ? (
              <>
                <p className="ai-drawer__big k-num">{cal.confidence.value.toFixed(2)}</p>
                <p className="text-xs text-muted">{cal.reliabilityLine}</p>
              </>
            ) : (
              <p className="text-xs text-muted">
                No calibrated confidence for this signal (n={cal.n}).
              </p>
            )}
          </div>
          <div className="ai-drawer__box">
            <h3 className="ai-drawer__h">Edge after costs</h3>
            <p
              className={`text-xs ${cal.edge === 'none' ? 'ai-drawer__warn' : ''}`}
              data-testid="robot-edge"
            >
              {cal.edgeStatement}
            </p>
            <p className="text-xs text-muted">Out-of-sample trades, n={cal.n}.</p>
          </div>
        </section>
      ) : null}

      {insights?.suggestions.length ? (
        <section aria-label="Suggestions (draft)" className="flex flex-col gap-2">
          {insights.suggestions.map((s) => (
            <div key={s.code} className="ai-drawer__suggest" data-testid={`suggestion-${s.code}`}>
              <h3 className="ai-drawer__h">Suggestion (draft)</h3>
              <p className="m-0 text-xs font-semibold">{s.title}</p>
              <p className="m-0 text-xs">{s.detail}</p>
              {s.draft ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void createDraft(s)}
                  data-testid="suggestion-create-draft"
                >
                  Create draft
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {draft ? (
        <div className="ai-drawer__suggest" data-testid="strategy-draft">
          <p className="m-0 text-xs font-semibold">Unapproved draft (not a version yet)</p>
          <ul className="m-0 list-none p-0 text-xs">
            {draft.changes.map((c) => (
              <li key={c.param}>
                {c.param}: <span className="k-num">{c.from}</span> →{' '}
                <span className="k-num">{c.to}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void saveDraft()}
              data-testid="strategy-draft-save"
            >
              Save as new version
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void dismissDraft()}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="text-xs" role="status" data-testid="copilot-notice">
          {notice}
        </p>
      ) : null}

      <section aria-label="No-edge scan">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void aiApi
              .scanNoEdge()
              .then(setScan)
              .catch((e: Error) => setNotice(e.message))
          }
          data-testid="scan-no-edge"
        >
          Scan my robots for no edge after costs
        </Button>
        {scan ? (
          <ul
            className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-xs"
            data-testid="scan-results"
          >
            {scan.robots.map((r) => (
              <li key={r.robotId} className={r.edge === 'none' ? 'ai-drawer__warn' : ''}>
                <strong>{r.name}</strong>: {r.statement} {r.recommendation}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-label="Ask the copilot">
        <h3 className="ai-drawer__h">Ask the copilot</h3>
        <CopilotChat
          surface="robots"
          context={{
            panel: 'robots',
            robotId: robotId ?? undefined,
            strategyId: strategyId ?? undefined,
            signalId: signalId ?? undefined,
          }}
          placeholder="Why did it trade? Is there an edge?"
        />
      </section>
      <p className="m-0 text-xs text-muted">Suggests, never executes · Not investment advice.</p>
    </div>
  );
}
