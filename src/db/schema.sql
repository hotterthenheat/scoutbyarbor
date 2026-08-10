-- ─────────────────────────────────────────────────────────────────────────────
-- Scout by Arbor Capital — storage schema (§24)
--
-- Five logical stores, exactly as specified:
--   raw_posts     verbatim provider payloads, never mutated
--   news_events   one row per processed post
--   events        clustered real-world events (§18)
--   event_updates developments within a cluster
--   sources       config-driven watchlist (§36)
--   source_health liveness, so "quiet" is distinguishable from "broken" (§23)
--
-- SQLite with WAL. Every schema change appends a new numbered block below and
-- bumps user_version; migrations are applied in order and are idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Sources (§21, §36) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  handle              TEXT,
  url                 TEXT,
  source_type         TEXT NOT NULL CHECK (source_type IN ('x','rss','edgar','manual')),
  category            TEXT NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 50,
  enabled             INTEGER NOT NULL DEFAULT 1,
  verified            INTEGER NOT NULL DEFAULT 0,
  quality_score       INTEGER NOT NULL DEFAULT 70,
  noise_score         INTEGER NOT NULL DEFAULT 30,
  macro_score         INTEGER NOT NULL DEFAULT 50,
  micro_score         INTEGER NOT NULL DEFAULT 50,
  geopolitical_score  INTEGER NOT NULL DEFAULT 50,
  filter_profile      TEXT NOT NULL DEFAULT 'standard'
                        CHECK (filter_profile IN ('standard','strict')),
  official            INTEGER NOT NULL DEFAULT 0,
  -- The ORGANISATION behind the feed. rss:bls-latest and x:bls are two channels
  -- of one body, and counting them as two confirmations would make every CPI
  -- print look independently corroborated when one agency reported it once.
  org                 TEXT,
  expected_interval_ms INTEGER NOT NULL DEFAULT 900000,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_enabled  ON sources(enabled, source_type);
CREATE INDEX IF NOT EXISTS idx_sources_priority ON sources(priority DESC);

-- Rolling behavioural statistics (§21, §28).
CREATE TABLE IF NOT EXISTS source_stats (
  source_id             TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  posts_received        INTEGER NOT NULL DEFAULT 0,
  posts_accepted        INTEGER NOT NULL DEFAULT 0,
  posts_rejected        INTEGER NOT NULL DEFAULT 0,
  duplicates            INTEGER NOT NULL DEFAULT 0,
  false_positives       INTEGER NOT NULL DEFAULT 0,
  late_posts            INTEGER NOT NULL DEFAULT 0,
  material_events       INTEGER NOT NULL DEFAULT 0,
  average_daily_posts   REAL NOT NULL DEFAULT 0,
  useful_post_ratio     REAL NOT NULL DEFAULT 0,
  historical_accuracy   REAL NOT NULL DEFAULT 1.0,
  avg_source_latency_ms REAL NOT NULL DEFAULT 0,
  window_start          TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Liveness (§23).
CREATE TABLE IF NOT EXISTS source_health (
  source_id            TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  state                TEXT NOT NULL
                         CHECK (state IN ('ACTIVE','DELAYED','STALE','DISCONNECTED','ERROR')),
  last_success_at      TEXT,
  last_item_at         TEXT,
  last_error_at        TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  expected_interval_ms INTEGER NOT NULL DEFAULT 900000,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_health_state ON source_health(state);

-- ── Raw posts ────────────────────────────────────────────────────────────────
-- Immutable landing table. Written before any processing so a bad classifier
-- release can be replayed against real traffic (`npm run replay`).
CREATE TABLE IF NOT EXISTS raw_posts (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_post_id  TEXT NOT NULL,
  original_url    TEXT,
  author          TEXT,
  text            TEXT NOT NULL,
  event_time      TEXT NOT NULL,
  ingestion_time  TEXT NOT NULL,
  meta            TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  UNIQUE (source_id, source_post_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_posts_time   ON raw_posts(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_raw_posts_source ON raw_posts(source_id, event_time DESC);

-- ── Event clusters (§18) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  -- Human-readable event key, e.g. iran-us-deal-2026-05-28. Stable for the
  -- life of the cluster so downstream systems can refer to an event by name.
  slug             TEXT NOT NULL DEFAULT '',
  headline         TEXT NOT NULL,
  category         TEXT NOT NULL,
  subcategory      TEXT,
  tickers          TEXT NOT NULL DEFAULT '[]',
  countries        TEXT NOT NULL DEFAULT '[]',
  entities         TEXT NOT NULL DEFAULT '[]',
  importance       REAL NOT NULL DEFAULT 0,
  band             TEXT NOT NULL DEFAULT 'LOW',
  source_count     INTEGER NOT NULL DEFAULT 1,
  -- Distinct source ids that have reported this event. Corroboration must
  -- count independent wires, not repeat posts from one of them (§19).
  source_ids       TEXT NOT NULL DEFAULT '[]',
  -- Per-source detail behind source_ids: which bot, which channel, which
  -- account, and when each first reported. "DISCORD" is not a useful answer to
  -- "where did this come from"; "OwlsKeyLevelsBot" is.
  contributors     TEXT NOT NULL DEFAULT '[]',
  post_count       INTEGER NOT NULL DEFAULT 1,
  first_seen_at    TEXT NOT NULL,
  last_updated_at  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  discord_messages TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_slug   ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_open   ON events(status, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_cat    ON events(category, last_updated_at DESC);

-- ── Processed posts (§24 news_events) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_events (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_post_id      TEXT NOT NULL,
  original_url        TEXT,
  author              TEXT,
  timestamp           TEXT NOT NULL,
  raw_text            TEXT NOT NULL,
  clean_text          TEXT NOT NULL,
  headline            TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  category            TEXT,
  subcategory         TEXT,
  entities            TEXT NOT NULL DEFAULT '{}',
  tickers             TEXT NOT NULL DEFAULT '[]',
  countries           TEXT NOT NULL DEFAULT '[]',
  event_id            TEXT REFERENCES events(id) ON DELETE SET NULL,
  importance          REAL NOT NULL DEFAULT 0,
  novelty             REAL NOT NULL DEFAULT 0,
  market_relevance    REAL NOT NULL DEFAULT 0,
  confidence          REAL NOT NULL DEFAULT 0,
  score               TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  rejection_reason    TEXT,
  earnings            TEXT,
  filing              TEXT,
  fingerprint         TEXT NOT NULL DEFAULT '',
  simhash             TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  processed_at        TEXT,
  discord_message_id  TEXT,
  -- §22 latency
  ingestion_time      TEXT NOT NULL,
  processing_time     TEXT,
  discord_time        TEXT,
  source_to_scout_ms  INTEGER,
  scout_to_discord_ms INTEGER,
  total_latency_ms    INTEGER,
  UNIQUE (source, source_post_id)
);

CREATE INDEX IF NOT EXISTS idx_news_events_time      ON news_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_news_events_cluster   ON news_events(event_id);
CREATE INDEX IF NOT EXISTS idx_news_events_status    ON news_events(status, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_news_events_fp        ON news_events(fingerprint);
CREATE INDEX IF NOT EXISTS idx_news_events_url       ON news_events(original_url);
CREATE INDEX IF NOT EXISTS idx_news_events_category  ON news_events(category, timestamp DESC);

-- ── Cluster developments (§18) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_updates (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  news_event_id  TEXT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  headline       TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  occurred_at    TEXT NOT NULL,
  importance     REAL NOT NULL DEFAULT 0,
  supersedes     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_updates_event ON event_updates(event_id, occurred_at DESC);

-- ── Security master (§25) ────────────────────────────────────────────────────
-- The ticker dictionary. `ambiguity` is what stops META-ANALYSIS → META.
CREATE TABLE IF NOT EXISTS securities (
  ticker     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  aliases    TEXT NOT NULL DEFAULT '[]',
  exchange   TEXT NOT NULL DEFAULT '',
  ambiguity  TEXT NOT NULL DEFAULT 'ambiguous'
               CHECK (ambiguity IN ('safe','ambiguous','blocked')),
  indices    TEXT NOT NULL DEFAULT '[]',
  sector     TEXT,
  priority   INTEGER NOT NULL DEFAULT 50
);

CREATE INDEX IF NOT EXISTS idx_securities_priority ON securities(priority DESC);

-- ── Discord delivery log ─────────────────────────────────────────────────────
-- Lets updates edit the right message in the right channel (§18, §26).
CREATE TABLE IF NOT EXISTS discord_messages (
  id           TEXT PRIMARY KEY,
  event_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
  news_event_id TEXT REFERENCES news_events(id) ON DELETE CASCADE,
  channel_key  TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  thread_id    TEXT,
  sent_at      TEXT NOT NULL,
  edited_at    TEXT,
  UNIQUE (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_messages_event ON discord_messages(event_id);

-- ── Pipeline metrics (§22, §28, §34) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket       TEXT NOT NULL,          -- ISO hour bucket
  metric       TEXT NOT NULL,          -- 'latency_total_ms', 'alerts_sent', …
  source_id    TEXT,
  category     TEXT,
  count        INTEGER NOT NULL DEFAULT 0,
  sum          REAL NOT NULL DEFAULT 0,
  min          REAL,
  max          REAL,
  UNIQUE (bucket, metric, source_id, category)
);

CREATE INDEX IF NOT EXISTS idx_metrics_bucket ON pipeline_metrics(bucket DESC, metric);

-- Individual latency samples, kept for P95/P99 (§22). Trimmed by retention job.
CREATE TABLE IF NOT EXISTS latency_samples (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  news_event_id   TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_to_scout_ms INTEGER,
  scout_to_discord_ms INTEGER,
  -- How long the event sat in the queue before a worker picked it up, and how
  -- long the Sprout hand-off took. Together with the columns above these
  -- separate "the upstream source was slow" from "Scout was slow".
  queue_wait_ms   INTEGER,
  sprout_ms       INTEGER,
  total_ms        INTEGER,
  recorded_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_latency_recorded ON latency_samples(recorded_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 24/7 URL INGESTION
--
-- Scout watches configured Discord channels for X post URLs and processes them
-- as they arrive. These tables are what make that survive a restart: the
-- processed-post set must never live only in RAM, or a redeploy would repost
-- the last several hundred items.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per resolved post, keyed by the platform-native id (`x:<post_id>`),
-- so the same post arriving through five channels collapses to one row.
CREATE TABLE IF NOT EXISTS posts (
  post_id          TEXT PRIMARY KEY,   -- canonical, e.g. x:2058552301120360937
  author           TEXT,
  author_handle    TEXT,
  text             TEXT NOT NULL DEFAULT '',
  -- NULL when the genuine publication time is unavailable. The Discord receive
  -- time is NEVER substituted here.
  published_at     TEXT,
  canonical_url    TEXT,
  -- How the content reached Scout: 'webhook', 'discord-relay', 'x-api-v2'.
  retrieval_source TEXT NOT NULL DEFAULT 'unknown',
  -- The platform the post came FROM, and the upstream relay/service that
  -- pushed it. Kept apart from author/handle, which describe the original
  -- account — conflating them makes debugging a bad feed much harder.
  platform         TEXT,
  upstream_source  TEXT,
  -- When Scout received it. Deliberately a different column from published_at,
  -- which stays NULL when the true publication time is unknown.
  received_at      TEXT,
  discord_received_at TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_retrieval ON posts(retrieval_source, received_at DESC);

-- Per-destination delivery log, so a partial Discord outage is visible and
-- retryable rather than silent.
CREATE TABLE IF NOT EXISTS deliveries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL,
  destination        TEXT NOT NULL,   -- channel key, or 'sprout'
  status             TEXT NOT NULL,   -- PENDING | SENT | FAILED | SKIPPED
  discord_message_id TEXT,
  sent_at            TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  -- Replay claim. A row being worked on by one replay run is invisible to
  -- another, so two concurrent runs cannot deliver the same event twice.
  -- Cleared whenever a new status is recorded; a claim older than the stale
  -- threshold is reclaimed, so a run that died mid-flight cannot block a row
  -- forever.
  claimed_at         TEXT,
  claimed_by         TEXT,
  UNIQUE (event_id, destination)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_claim  ON deliveries(destination, status, claimed_at);

-- The work queue. Persisted so in-flight work resumes after a restart instead
-- of being lost or duplicated.
CREATE TABLE IF NOT EXISTS processing_jobs (
  job_id          TEXT PRIMARY KEY,
  post_id         TEXT NOT NULL,
  url             TEXT NOT NULL,
  source_channel  TEXT,
  source_kind     TEXT NOT NULL DEFAULT 'news',  -- news | truth_social | admin | webhook | discord
  status          TEXT NOT NULL DEFAULT 'QUEUED',
                    -- QUEUED | RUNNING | DONE | FAILED | FAILED_RETRIEVAL | SKIPPED
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT,
  -- Everything needed to process this job WITHOUT the message that created it.
  --
  -- A relayed post's content arrives once, in a Discord message Scout never
  -- sees again — the listener subscribes to new messages and does no history
  -- scraping. Holding that content only in memory meant a restart left a job
  -- row that could never be completed: the resolver chain would find nothing,
  -- fail non-retriably, and the news item was gone. So the payload is written
  -- in the same INSERT as the job itself, and a queued job is recoverable
  -- entirely from this table.
  --
  -- Cleared only on successful completion. A failed or retrying job keeps it,
  -- because that is precisely when it is still needed.
  relay_payload   TEXT,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  UNIQUE (post_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON processing_jobs(status, next_attempt_at);

-- Calendar reminders already sent, so a restart does not refire them.
CREATE TABLE IF NOT EXISTS calendar_fired (
  key      TEXT PRIMARY KEY,   -- "<eventId>:<leadMinutes>"
  fired_at TEXT NOT NULL
);

-- Durable key/value for facts about the deployment itself.
--
-- This exists for one reason: to make the persistent disk PROVABLE. Scout keeps
-- every piece of state it has — dedupe history, delivery log, calendar-fired
-- keys, the job queue — in this one SQLite file. If that file is not on a
-- mounted disk, every restart silently resets all of it and Scout reposts old
-- news as if it were new. Nothing about that failure is visible from the
-- outside: the service boots, reports healthy, and quietly has amnesia.
--
-- So the boot counter below survives restarts by definition. If it still reads
-- 1 after a redeploy, the disk is not attached. That is a fact an operator can
-- read rather than a configuration they have to trust.
CREATE TABLE IF NOT EXISTS runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
