import type {
  Category,
  EarningsData,
  EventStatus,
  ExtractedEntities,
  ExtractedFigure,
  FilingData,
  NewsEvent,
  RejectionReason,
  ScoreBreakdown,
  TickerMatch,
} from '../../core/types.js';
import {
  createStatementCache,
  nowIso,
  parseJson,
  parseJsonArray,
  toJson,
  toNullableNumber,
  toNullableText,
  toNumber,
  toText,
  type Bind,
  type SqliteDatabase,
} from '../index.js';

/**
 * One row per processed post (§24). `fingerprint`/`simhash` live in the table
 * but not on `NewsEvent` — they are dedupe machinery, not part of the event —
 * so writes accept them as optional extras and reads hand them back.
 */
export type NewsEventRecord = NewsEvent & { fingerprint?: string; simhash?: string };

/** The slim projection the dedupe/cluster stage scans on every ingested post. */
export interface DedupeCandidate {
  id: string;
  headline: string;
  /** Kept on the projection so URL dedupe runs in the same pass (§17). */
  originalUrl: string | null;
  fingerprint: string;
  simhash: string;
  tickers: string[];
  countries: string[];
  category: Category | null;
  eventId: string | null;
  timestamp: string;
  importance: number;
}

export interface NewsEventRepo {
  /** Insert, or refresh in place if this id was already stored (replay-safe). */
  insert(event: NewsEventRecord): void;
  update(event: NewsEventRecord): void;
  byId(id: string): NewsEventRecord | null;
  findByUrl(url: string): NewsEventRecord | null;
  findBySourcePost(source: string, sourcePostId: string): NewsEventRecord | null;
  /** Newest first, capped at 500 — the dedupe window, not the whole table. */
  dedupeCandidates(sinceIso: string): DedupeCandidate[];
  /** The processed posts belonging to a cluster, newest first. */
  byEventId(eventId: string): NewsEventRecord[];
  /** Lookup by provider post id alone, when the source is not known. */
  bySourcePostId(sourcePostId: string): NewsEventRecord | null;
  setStatus(id: string, status: EventStatus, reason: RejectionReason | null): void;
  setDiscordMessageId(id: string, messageId: string): void;
  countsByStatus(sinceIso: string): Record<string, number>;
  /**
   * Why events were dropped, by reason.
   *
   * A tight freshness window makes the wire quiet on purpose, and "quiet
   * because everything arrived four minutes late" is indistinguishable from
   * "quiet because ingestion broke" unless the reasons are counted.
   */
  countsByRejection(sinceIso: string): Record<string, number>;
}

const DEDUPE_LIMIT = 500;

/** Column order is defined once; params are projected through it. */
const COLUMNS = [
  'id',
  'source',
  'source_post_id',
  'original_url',
  'author',
  'timestamp',
  'raw_text',
  'clean_text',
  'headline',
  'body',
  'category',
  'subcategory',
  'entities',
  'tickers',
  'countries',
  'event_id',
  'importance',
  'novelty',
  'market_relevance',
  'confidence',
  'score',
  'status',
  'rejection_reason',
  'earnings',
  'filing',
  'fingerprint',
  'simhash',
  'created_at',
  'processed_at',
  'discord_message_id',
  'ingestion_time',
  'processing_time',
  'discord_time',
  'source_to_scout_ms',
  'scout_to_discord_ms',
  'total_latency_ms',
] as const;

type ColumnName = (typeof COLUMNS)[number];

/** Immutable once written: identity and first-seen time. */
const FROZEN: ReadonlySet<string> = new Set<ColumnName>(['id', 'created_at']);

/** A blank hash must never clobber one that was computed earlier. */
const HASH_COLUMNS: ReadonlySet<string> = new Set<ColumnName>(['fingerprint', 'simhash']);

const MUTABLE = COLUMNS.filter((c) => !FROZEN.has(c));

const INSERT_SQL = `
  INSERT INTO news_events (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET ${MUTABLE.map((c) =>
    HASH_COLUMNS.has(c)
      ? `${c} = COALESCE(NULLIF(excluded.${c}, ''), news_events.${c})`
      : `${c} = excluded.${c}`,
  ).join(', ')}`;

const UPDATE_SQL = `
  UPDATE news_events SET ${MUTABLE.map((c) =>
    HASH_COLUMNS.has(c) ? `${c} = COALESCE(NULLIF(?, ''), ${c})` : `${c} = ?`,
  ).join(', ')}
  WHERE id = ?`;

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM news_events`;

interface NewsEventRow {
  id: string;
  source: string;
  source_post_id: string;
  original_url: string | null;
  author: string | null;
  timestamp: string;
  raw_text: string;
  clean_text: string;
  headline: string;
  body: string;
  category: string | null;
  subcategory: string | null;
  entities: string;
  tickers: string;
  countries: string;
  event_id: string | null;
  importance: number;
  novelty: number;
  market_relevance: number;
  confidence: number;
  score: string | null;
  status: string;
  rejection_reason: string | null;
  earnings: string | null;
  filing: string | null;
  fingerprint: string;
  simhash: string;
  created_at: string;
  processed_at: string | null;
  discord_message_id: string | null;
  ingestion_time: string;
  processing_time: string | null;
  discord_time: string | null;
  source_to_scout_ms: number | null;
  scout_to_discord_ms: number | null;
  total_latency_ms: number | null;
}

const EMPTY_ENTITIES: ExtractedEntities = {
  tickers: [],
  countries: [],
  organizations: [],
  people: [],
  commodities: [],
  figures: [],
};

/** Tolerates partially-shaped JSON: a half-written column still yields a usable object. */
function toEntities(raw: unknown): ExtractedEntities {
  const parsed = parseJson<Partial<ExtractedEntities> | null>(raw, null);
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_ENTITIES };
  return {
    tickers: Array.isArray(parsed.tickers) ? (parsed.tickers as TickerMatch[]) : [],
    countries: Array.isArray(parsed.countries) ? parsed.countries : [],
    organizations: Array.isArray(parsed.organizations) ? parsed.organizations : [],
    people: Array.isArray(parsed.people) ? parsed.people : [],
    commodities: Array.isArray(parsed.commodities) ? parsed.commodities : [],
    figures: Array.isArray(parsed.figures) ? (parsed.figures as ExtractedFigure[]) : [],
  };
}

function toNewsEvent(row: NewsEventRow): NewsEventRecord {
  return {
    id: row.id,
    source: row.source,
    sourcePostId: row.source_post_id,
    originalUrl: toNullableText(row.original_url),
    author: toNullableText(row.author),
    timestamp: toText(row.timestamp),
    rawText: toText(row.raw_text),
    cleanText: toText(row.clean_text),
    headline: toText(row.headline),
    body: toText(row.body),
    category: toNullableText(row.category) as Category | null,
    subcategory: toNullableText(row.subcategory),
    entities: toEntities(row.entities),
    tickers: parseJsonArray<string>(row.tickers),
    countries: parseJsonArray<string>(row.countries),
    eventId: toNullableText(row.event_id),
    importance: toNumber(row.importance),
    novelty: toNumber(row.novelty),
    marketRelevance: toNumber(row.market_relevance),
    confidence: toNumber(row.confidence),
    score: parseJson<ScoreBreakdown | null>(row.score, null),
    status: toText(row.status, 'PENDING') as EventStatus,
    rejectionReason: toNullableText(row.rejection_reason) as RejectionReason | null,
    earnings: parseJson<EarningsData | null>(row.earnings, null),
    filing: parseJson<FilingData | null>(row.filing, null),
    fingerprint: toText(row.fingerprint),
    simhash: toText(row.simhash),
    createdAt: toText(row.created_at),
    processedAt: toNullableText(row.processed_at),
    discordMessageId: toNullableText(row.discord_message_id),
    latency: {
      // The event time is the timestamp column; it is not stored twice.
      eventTime: toText(row.timestamp),
      ingestionTime: toText(row.ingestion_time),
      processingTime: toNullableText(row.processing_time),
      discordTime: toNullableText(row.discord_time),
      sourceToScoutMs: toNullableNumber(row.source_to_scout_ms),
      scoutToDiscordMs: toNullableNumber(row.scout_to_discord_ms),
      totalMs: toNullableNumber(row.total_latency_ms),
    },
  };
}

function toValues(e: NewsEventRecord): Record<ColumnName, Bind> {
  const latency = e.latency;
  return {
    id: e.id,
    source: e.source,
    source_post_id: e.sourcePostId,
    original_url: e.originalUrl,
    author: e.author,
    timestamp: e.timestamp,
    raw_text: e.rawText,
    clean_text: e.cleanText,
    headline: e.headline,
    body: e.body ?? '',
    category: e.category,
    subcategory: e.subcategory,
    entities: toJson(e.entities ?? EMPTY_ENTITIES),
    tickers: toJson(e.tickers ?? []),
    countries: toJson(e.countries ?? []),
    event_id: e.eventId,
    importance: e.importance,
    novelty: e.novelty,
    market_relevance: e.marketRelevance,
    confidence: e.confidence,
    score: e.score ? toJson(e.score) : null,
    status: e.status,
    rejection_reason: e.rejectionReason,
    earnings: e.earnings ? toJson(e.earnings) : null,
    filing: e.filing ? toJson(e.filing) : null,
    fingerprint: e.fingerprint ?? '',
    simhash: e.simhash ?? '',
    created_at: e.createdAt || nowIso(),
    processed_at: e.processedAt,
    discord_message_id: e.discordMessageId,
    ingestion_time: latency?.ingestionTime ?? e.createdAt ?? nowIso(),
    processing_time: latency?.processingTime ?? null,
    discord_time: latency?.discordTime ?? null,
    source_to_scout_ms: latency?.sourceToScoutMs ?? null,
    scout_to_discord_ms: latency?.scoutToDiscordMs ?? null,
    total_latency_ms: latency?.totalMs ?? null,
  };
}

export function createNewsEventRepo(db: SqliteDatabase): NewsEventRepo {
  const stmts = createStatementCache(db);

  return {
    insert(event: NewsEventRecord): void {
      const values = toValues(event);
      stmts.get(INSERT_SQL).run(...COLUMNS.map((c) => values[c]));
    },

    update(event: NewsEventRecord): void {
      const values = toValues(event);
      stmts.get(UPDATE_SQL).run(...MUTABLE.map((c) => values[c]), event.id);
    },

    byId(id: string): NewsEventRecord | null {
      const row = stmts.get<NewsEventRow>(`${SELECT_ALL} WHERE id = ?`).get(id);
      return row ? toNewsEvent(row) : null;
    },

    findByUrl(url: string): NewsEventRecord | null {
      // Empty/absent urls are common (X posts) and must not all match each other.
      if (!url) return null;
      const row = stmts
        .get<NewsEventRow>(`${SELECT_ALL} WHERE original_url = ? ORDER BY timestamp DESC LIMIT 1`)
        .get(url);
      return row ? toNewsEvent(row) : null;
    },

    findBySourcePost(source: string, sourcePostId: string): NewsEventRecord | null {
      const row = stmts
        .get<NewsEventRow>(`${SELECT_ALL} WHERE source = ? AND source_post_id = ?`)
        .get(source, sourcePostId);
      return row ? toNewsEvent(row) : null;
    },

    byEventId(eventId: string): NewsEventRecord[] {
      return stmts
        .get<NewsEventRow>(`${SELECT_ALL} WHERE event_id = ? ORDER BY timestamp DESC`)
        .all(eventId)
        .map(toNewsEvent);
    },

    bySourcePostId(sourcePostId: string): NewsEventRecord | null {
      const row = stmts
        .get<NewsEventRow>(`${SELECT_ALL} WHERE source_post_id = ? ORDER BY timestamp DESC LIMIT 1`)
        .get(sourcePostId);
      return row ? toNewsEvent(row) : null;
    },

    dedupeCandidates(sinceIso: string): DedupeCandidate[] {
      const rows = stmts
        .get<{
          id: string;
          headline: string;
          original_url: string | null;
          fingerprint: string;
          simhash: string;
          tickers: string;
          countries: string;
          category: string | null;
          event_id: string | null;
          timestamp: string;
          importance: number;
        }>(`
          SELECT id, headline, original_url, fingerprint, simhash, tickers, countries,
                 category, event_id, timestamp, importance
            FROM news_events
           WHERE timestamp >= ?
             -- An event Scout never understood must not suppress a later
             -- source that words the same story comprehensibly. NO_CATEGORY and
             -- EMPTY_TEXT mean "we could not read this", not "we read it and
             -- declined it" — so a second wire describing the same development
             -- clearly gets a fresh hearing rather than being collapsed into a
             -- decision that produced no alert.
             --
             -- Everything else stays a candidate. A story rejected as NOISE was
             -- understood and deliberately declined; re-admitting it because
             -- another account posted the same chatter would reopen exactly the
             -- floodgate the noise filters exist to close.
             AND COALESCE(rejection_reason, '') NOT IN ('NO_CATEGORY', 'EMPTY_TEXT')
           ORDER BY timestamp DESC
           LIMIT ${DEDUPE_LIMIT}
        `)
        .all(sinceIso);

      return rows.map((row) => ({
        id: row.id,
        headline: toText(row.headline),
        originalUrl: toNullableText(row.original_url),
        fingerprint: toText(row.fingerprint),
        simhash: toText(row.simhash),
        tickers: parseJsonArray<string>(row.tickers),
        countries: parseJsonArray<string>(row.countries),
        category: toNullableText(row.category) as Category | null,
        eventId: toNullableText(row.event_id),
        timestamp: toText(row.timestamp),
        importance: toNumber(row.importance),
      }));
    },

    setStatus(id: string, status: EventStatus, reason: RejectionReason | null): void {
      stmts
        .get('UPDATE news_events SET status = ?, rejection_reason = ? WHERE id = ?')
        .run(status, reason, id);
    },

    setDiscordMessageId(id: string, messageId: string): void {
      stmts.get('UPDATE news_events SET discord_message_id = ? WHERE id = ?').run(messageId, id);
    },

    countsByStatus(sinceIso: string): Record<string, number> {
      const rows = stmts
        .get<{ status: string; n: number }>(`
          SELECT status, COUNT(*) AS n FROM news_events WHERE timestamp >= ? GROUP BY status
        `)
        .all(sinceIso);
      const out: Record<string, number> = {};
      for (const row of rows) out[row.status] = toNumber(row.n);
      return out;
    },

    countsByRejection(sinceIso: string): Record<string, number> {
      const rows = stmts
        .get<{ reason: string; n: number }>(`
          SELECT rejection_reason AS reason, COUNT(*) AS n
            FROM news_events
           WHERE timestamp >= ? AND rejection_reason IS NOT NULL
           GROUP BY rejection_reason
           ORDER BY n DESC
        `)
        .all(sinceIso);
      const out: Record<string, number> = {};
      for (const row of rows) out[row.reason] = toNumber(row.n);
      return out;
    },
  };
}
