import { NEWS_FIXTURES } from './core/news-fixtures';
import type { NewsAdapter, NewsArticleInput } from './core/news-pipeline';

/**
 * News sources (goal 07B §4). The SIMULATED adapter serves the invented multilingual fixtures;
 * the three provider adapters are flagged stubs: off unless their flag is set and, even then, their
 * live transport refuses to connect because no licensed news contract exists (OQ-M4).
 */
export class SimulatedNewsAdapter implements NewsAdapter {
  readonly id = 'simulated';
  readonly regions = ['americas', 'europe', 'africa', 'asia', 'oceania'];
  readonly languages = ['en', 'ja', 'zh', 'de', 'fr', 'es', 'pt', 'ar'];
  readonly flagged = false;
  readonly licensed = false;

  async fetchSince(since: Date, now: Date): Promise<NewsArticleInput[]> {
    return NEWS_FIXTURES.map((f) => ({
      provider: 'simulated',
      externalId: f.externalId,
      sourceName: f.sourceName,
      url: `https://news.simulated.invalid/${f.externalId}`,
      language: f.language,
      title: f.title,
      body: f.body,
      publishedAt: new Date(now.getTime() - f.hoursAgo * 3_600_000),
      simulated: true,
    })).filter((a) => a.publishedAt >= since);
  }
}

export class NewsProviderNotConfiguredError extends Error {
  constructor(
    readonly adapter: string,
    reason: string,
  ) {
    super(`News provider ${adapter} is not available: ${reason}`);
  }
}

export class FlaggedNewsStub implements NewsAdapter {
  readonly flagged = true;
  readonly licensed = false;

  constructor(
    readonly id: string,
    readonly flag: string,
    readonly regions: readonly string[],
    readonly languages: readonly string[],
  ) {}

  async fetchSince(): Promise<NewsArticleInput[]> {
    if (process.env[this.flag] !== 'true')
      throw new NewsProviderNotConfiguredError(
        this.id,
        `disabled by feature flag (set ${this.flag}=true to enable the stub)`,
      );
    throw new NewsProviderNotConfiguredError(
      this.id,
      'no licensed news contract; the live transport is not implemented (OQ-M4)',
    );
  }
}

export const NEWS_STUBS: FlaggedNewsStub[] = [
  new FlaggedNewsStub(
    'newswire-americas',
    'KORA_NEWS_ADAPTER_AMERICAS',
    ['americas'],
    ['en', 'es', 'pt', 'fr'],
  ),
  new FlaggedNewsStub(
    'newswire-emea',
    'KORA_NEWS_ADAPTER_EMEA',
    ['europe', 'africa'],
    ['en', 'de', 'fr', 'es', 'ar'],
  ),
  new FlaggedNewsStub(
    'newswire-apac',
    'KORA_NEWS_ADAPTER_APAC',
    ['asia', 'oceania'],
    ['en', 'ja', 'zh'],
  ),
];
