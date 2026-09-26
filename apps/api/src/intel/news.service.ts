import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { AiService } from '../ai/ai.service';
import { BudgetService } from '../ai/budget.service';
import type { ProviderUsage } from '../ai/core/types';
import { MetricsService } from '../ai/metrics.service';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import {
  contentHash,
  ENTITY_ALIASES,
  findDuplicate,
  guessLanguage,
  linkEntities,
  normaliseText,
  type DedupCandidate,
  type EntityTerm,
  type NewsAdapter,
} from './core/news-pipeline';
import { scoreArticle, translateArticle } from './core/news-score';
import { loadIntelConfig } from './intel-config';
import { IntelReadService } from './intel-read.service';
import { NEWS_STUBS, NewsProviderNotConfiguredError, SimulatedNewsAdapter } from './news-adapters';

export interface IngestSummary {
  adapter: string;
  status: 'ok' | 'unavailable';
  message?: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  scored: number;
  invalid: number;
  unscored: number;
  languages: Record<string, number>;
}

const SYSTEM_USER = 'system:news';
const ZERO: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * News pipeline (goal 07B §4): adapter → normalise → dedup → entity linking → translation and
 * per-article scoring through the goal 07 gateway (structured outputs, zod-validated, article
 * wrapped as untrusted data) → stored with source, time and link for citations. Every model call is
 * audited as `ai.request` (surface `news`) and counted against the organisation's token budget.
 */
@Injectable()
export class NewsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('IntelNews');
  private timer: NodeJS.Timeout | null = null;
  private readonly adapters: Map<string, NewsAdapter>;

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly budget: BudgetService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
    private readonly read: IntelReadService,
  ) {
    this.adapters = new Map<string, NewsAdapter>([
      ['simulated', new SimulatedNewsAdapter()],
      ...NEWS_STUBS.map((s) => [s.id, s] as [string, NewsAdapter]),
    ]);
  }

  onModuleInit(): void {
    const cfg = loadIntelConfig();
    if (!cfg.news) return;
    const tick = () =>
      void this.ingest('simulated').catch((e: Error) =>
        this.log.warn(`news ingest failed: ${e.message}`),
      );
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, cfg.newsIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  adapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  private async terms(): Promise<EntityTerm[]> {
    const reg = await this.read.registry();
    const codes: EntityTerm[] = [...reg.keys()]
      .filter((s) => /^[A-Z]{3,}[A-Z0-9]*$/.test(s))
      .map((s) => ({ term: s, kind: 'symbol', ref: s, caseSensitive: true }));
    return [...ENTITY_ALIASES.filter((t) => t.kind === 'venue' || reg.has(t.ref)), ...codes];
  }

  async ingest(adapterId: string, now = new Date()): Promise<IngestSummary> {
    const summary: IngestSummary = {
      adapter: adapterId,
      status: 'ok',
      fetched: 0,
      inserted: 0,
      duplicates: 0,
      scored: 0,
      invalid: 0,
      unscored: 0,
      languages: {},
    };
    const adapter = this.adapters.get(adapterId);
    if (!adapter)
      return { ...summary, status: 'unavailable', message: `Unknown news adapter ${adapterId}.` };
    let articles;
    try {
      articles = await adapter.fetchSince(new Date(now.getTime() - 14 * 86_400_000), now);
    } catch (err) {
      if (err instanceof NewsProviderNotConfiguredError)
        return { ...summary, status: 'unavailable', message: err.message };
      throw err;
    }
    summary.fetched = articles.length;
    const terms = await this.terms();
    const earlierRows = await this.db.query<{
      id: string;
      content_hash: string;
      title: string;
      body: string;
      provider: string;
      external_id: string;
    }>(
      `SELECT id, content_hash, title, body, provider, external_id FROM news_articles
        WHERE published_at >= $1::timestamptz - interval '7 days'`,
      [now.toISOString()],
    );
    const seen = new Set(earlierRows.map((r) => `${r.provider}|${r.external_id}`));
    const earlier: DedupCandidate[] = earlierRows.map((r) => ({
      id: r.id,
      contentHash: r.content_hash,
      text: `${r.title}\n${r.body}`,
    }));
    const sorted = [...articles].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
    for (const a of sorted) {
      if (seen.has(`${a.provider}|${a.externalId}`)) continue;
      const title = normaliseText(a.title).slice(0, 500);
      const body = normaliseText(a.body).slice(0, 20_000);
      const hash = contentHash(title, body);
      const dup = findDuplicate(hash, `${title}\n${body}`, earlier);
      const lang =
        a.language && /^[a-z]{2}$/.test(a.language)
          ? a.language
          : guessLanguage(`${title} ${body}`);
      const row = await this.db.query<{ id: string }>(
        `INSERT INTO news_articles (provider, external_id, source_name, url, language, title, body, published_at, content_hash, dedup_of, simulated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          a.provider,
          a.externalId,
          normaliseText(a.sourceName).slice(0, 120),
          a.url.slice(0, 500),
          lang,
          title,
          body,
          a.publishedAt.toISOString(),
          hash,
          dup?.id ?? null,
          a.simulated,
        ],
      );
      const id = row[0]!.id;
      seen.add(`${a.provider}|${a.externalId}`);
      summary.inserted += 1;
      summary.languages[lang] = (summary.languages[lang] ?? 0) + 1;
      earlier.push({ id, contentHash: hash, text: `${title}\n${body}` });
      if (dup) {
        summary.duplicates += 1;
        continue;
      }
      const entities = linkEntities(`${title}\n${body}`, terms);
      for (const e of entities)
        await this.db.query(
          'INSERT INTO news_entities (article_id, kind, ref, match) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [id, e.kind, e.ref, e.match],
        );
      const status = await this.score(
        id,
        title,
        body,
        lang,
        entities.filter((e) => e.kind === 'symbol').map((e) => e.ref),
        a.publishedAt,
      );
      if (status === 'ok') summary.scored += 1;
      else if (status === 'invalid') summary.invalid += 1;
      else summary.unscored += 1;
    }
    return summary;
  }

  /** Translation (non-English) and scoring of one article; returns the stored score status. */
  async score(
    articleId: string,
    title: string,
    body: string,
    language: string,
    candidates: string[],
    publishedAt: Date,
  ): Promise<'ok' | 'invalid' | 'unavailable' | 'budget_exceeded' | 'error'> {
    const cfg = this.ai.config();
    const sel = this.ai.provider(cfg);
    const store = async (fields: {
      status: string;
      lang?: string | null;
      tTitle?: string | null;
      tSummary?: string | null;
      scores?: { sentiment: number; relevance: number; novelty: number; eventType: string } | null;
      modelId?: string | null;
      promptHash?: string | null;
      auditId?: string | null;
      errors?: string[];
    }) =>
      this.db.query(
        `INSERT INTO news_scores (article_id, status, detected_language, translated_title, translated_summary, sentiment, relevance, novelty, event_type, model_id, prompt_hash, audit_event_id, errors)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (article_id) DO UPDATE SET status = EXCLUDED.status, detected_language = EXCLUDED.detected_language,
           translated_title = EXCLUDED.translated_title, translated_summary = EXCLUDED.translated_summary,
           sentiment = EXCLUDED.sentiment, relevance = EXCLUDED.relevance, novelty = EXCLUDED.novelty,
           event_type = EXCLUDED.event_type, model_id = EXCLUDED.model_id, prompt_hash = EXCLUDED.prompt_hash,
           audit_event_id = EXCLUDED.audit_event_id, errors = EXCLUDED.errors, scored_at = clock_timestamp()`,
        [
          articleId,
          fields.status,
          fields.lang ?? language,
          fields.tTitle ?? null,
          fields.tSummary ?? null,
          fields.scores?.sentiment ?? null,
          fields.scores?.relevance ?? null,
          fields.scores?.novelty ?? null,
          fields.scores?.eventType ?? null,
          fields.modelId ?? null,
          fields.promptHash ?? null,
          fields.auditId ?? null,
          JSON.stringify(fields.errors ?? []),
        ],
      );
    if (!sel.provider) {
      await store({ status: 'unavailable', errors: [sel.reason ?? 'AI provider not configured'] });
      return 'unavailable';
    }
    const provider = sel.provider;
    const usage = await this.budget.usage(SYSTEM_USER, cfg).catch(() => null);
    if (usage && usage.orgUsed >= cfg.orgDailyTokens) {
      await store({
        status: 'budget_exceeded',
        modelId: provider.modelId,
        errors: ['organisation token budget reached'],
      });
      return 'budget_exceeded';
    }
    const total: ProviderUsage = { ...ZERO };
    const add = (u: ProviderUsage) => {
      total.inputTokens += u.inputTokens;
      total.outputTokens += u.outputTokens;
      total.cacheReadTokens += u.cacheReadTokens;
      total.cacheWriteTokens += u.cacheWriteTokens;
    };
    const errors: string[] = [];
    let lang: string | null = language;
    let tTitle: string | null = null;
    let tSummary: string | null = null;
    let promptHash: string | null = null;
    let status: 'ok' | 'invalid' | 'error' = 'error';
    let scores: {
      sentiment: number;
      relevance: number;
      novelty: number;
      eventType: string;
    } | null = null;
    try {
      if (language !== 'en') {
        const t = await translateArticle(provider, { id: articleId, title, body });
        add(t.usage);
        if (t.status === 'ok') {
          lang = t.value.language;
          tTitle = t.value.title;
          tSummary = t.value.summary;
        } else errors.push(...t.errors.map((e) => `translation: ${e}`));
      }
      const recent = candidates.length
        ? await this.db.query<{ id: string; title: string }>(
            `SELECT a.id, coalesce(s.translated_title, a.title) AS title FROM news_articles a
               LEFT JOIN news_scores s ON s.article_id = a.id
              WHERE a.id <> $1 AND a.dedup_of IS NULL AND a.published_at < $2 AND a.published_at >= $2::timestamptz - interval '7 days'
                AND EXISTS (SELECT 1 FROM news_entities e WHERE e.article_id = a.id AND e.kind = 'symbol' AND e.ref = ANY($3))
              ORDER BY a.published_at DESC LIMIT 5`,
            [articleId, publishedAt.toISOString(), candidates],
          )
        : [];
      const s = await scoreArticle(provider, { id: articleId, title, body }, candidates, recent);
      add(s.usage);
      promptHash = s.promptHash;
      if (s.status === 'ok') {
        status = 'ok';
        scores = {
          sentiment: s.value.sentiment,
          relevance: s.value.relevance,
          novelty: s.value.novelty,
          eventType: s.value.eventType,
        };
      } else {
        status = 'invalid';
        errors.push(...s.errors);
      }
    } catch (err) {
      status = 'error';
      errors.push(String((err as Error).message).slice(0, 200));
    }
    const tokens = total.inputTokens + total.outputTokens + total.cacheWriteTokens;
    await this.budget.add(SYSTEM_USER, cfg, tokens).catch(() => undefined);
    this.metrics.recordUsage(provider.modelId, 'news', total, cfg);
    this.metrics.requests.inc({ surface: 'news', mode: 'pro', status });
    const ev = await this.audit.record({
      actorId: SYSTEM_USER,
      actorType: 'ai',
      action: 'ai.request',
      entity: 'news_article',
      entityId: articleId,
      payload: {
        surface: 'news',
        task: 'news_score',
        status,
        modelId: provider.modelId,
        promptHash,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        candidates: candidates.length,
        schemaValid: status === 'ok',
        errors: errors.length,
      },
    });
    await store({
      status,
      lang,
      tTitle,
      tSummary,
      scores: status === 'ok' ? scores : null,
      modelId: provider.modelId,
      promptHash,
      auditId: ev.id,
      errors,
    });
    return status;
  }
}
