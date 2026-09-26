-- Goal 07B: news ingestion. Articles come from a NewsAdapter (SIMULATED fixtures today; licensed
-- providers are flagged stubs, OQ-M4). Every article keeps its source, publication time and link
-- so explanations can cite it. Scores are structured model outputs validated by schema; an output
-- that fails validation is stored as `invalid` and never used. Article text is untrusted data.

CREATE TABLE news_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9-]{1,40}$'),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128),
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 120),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 500),
  language text CHECK (language IS NULL OR language ~ '^[a-z]{2}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  body text NOT NULL CHECK (length(body) <= 20000),
  published_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  dedup_of uuid REFERENCES news_articles (id),
  simulated boolean NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX news_articles_published_idx ON news_articles (published_at DESC);
CREATE INDEX news_articles_hash_idx ON news_articles (content_hash);

CREATE TABLE news_entities (
  article_id uuid NOT NULL REFERENCES news_articles (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('symbol', 'venue')),
  ref text NOT NULL,
  match text NOT NULL CHECK (length(match) BETWEEN 1 AND 120),
  PRIMARY KEY (article_id, kind, ref)
);
CREATE INDEX news_entities_ref_idx ON news_entities (kind, ref);

CREATE TABLE news_scores (
  article_id uuid PRIMARY KEY REFERENCES news_articles (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ok', 'invalid', 'unavailable', 'budget_exceeded', 'error')),
  detected_language text CHECK (detected_language IS NULL OR detected_language ~ '^[a-z]{2}$'),
  translated_title text CHECK (translated_title IS NULL OR length(translated_title) <= 500),
  translated_summary text CHECK (translated_summary IS NULL OR length(translated_summary) <= 1200),
  sentiment double precision CHECK (sentiment IS NULL OR (sentiment >= -1 AND sentiment <= 1)),
  relevance double precision CHECK (relevance IS NULL OR (relevance >= 0 AND relevance <= 1)),
  novelty double precision CHECK (novelty IS NULL OR (novelty >= 0 AND novelty <= 1)),
  event_type text,
  model_id text,
  prompt_hash char(64),
  audit_event_id bigint,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  scored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A usable score is complete; anything else carries no scores at all.
  CHECK (
    (status = 'ok' AND sentiment IS NOT NULL AND relevance IS NOT NULL AND novelty IS NOT NULL)
    OR (status <> 'ok' AND sentiment IS NULL AND relevance IS NULL AND novelty IS NULL)
  )
);

GRANT SELECT, INSERT, UPDATE ON news_articles, news_entities, news_scores TO kora_app;
GRANT DELETE ON news_entities TO kora_app;
GRANT SELECT ON news_articles, news_entities, news_scores TO kora_audit_reader;
