import type { RawPost } from '../../core/types.js';
import { deterministicId } from '../../util/id.js';
import {
  createStatementCache,
  nowIso,
  parseJsonObject,
  toJson,
  toText,
  toNullableText,
  type SqliteDatabase,
} from '../index.js';

/**
 * Immutable landing table. Written before any processing so a bad classifier
 * release can be replayed against real traffic.
 */
export interface RawPostRepo {
  /** Row id on a fresh insert, `null` when this provider item was already stored. */
  insert(post: RawPost): string | null;
  exists(sourceId: string, sourcePostId: string): boolean;
  byId(id: string): RawPost | null;
  recent(limit: number): RawPost[];
}

interface RawPostRow {
  id: string;
  source_id: string;
  source_post_id: string;
  original_url: string | null;
  author: string | null;
  text: string;
  event_time: string;
  ingestion_time: string;
  meta: string;
  created_at: string;
}

/** Stable across replays: the same provider item always lands on the same row. */
export function rawPostId(sourceId: string, sourcePostId: string): string {
  return deterministicId('raw', sourceId, sourcePostId);
}

function toRawPost(row: RawPostRow): RawPost {
  return {
    sourceId: row.source_id,
    sourcePostId: row.source_post_id,
    originalUrl: toNullableText(row.original_url),
    author: toNullableText(row.author),
    text: toText(row.text),
    eventTime: toText(row.event_time),
    ingestionTime: toText(row.ingestion_time),
    meta: parseJsonObject<Record<string, unknown>>(row.meta, {}),
  };
}

const COLUMNS = `
  id, source_id, source_post_id, original_url, author, text, event_time,
  ingestion_time, meta, created_at`;

export function createRawPostRepo(db: SqliteDatabase): RawPostRepo {
  const stmts = createStatementCache(db);

  return {
    insert(post: RawPost): string | null {
      const id = rawPostId(post.sourceId, post.sourcePostId);
      // OR IGNORE against UNIQUE(source_id, source_post_id) is the exact
      // post-id dedupe of §17 — cheapest possible rejection, no read first.
      // Foreign-key violations still raise, so an unknown source_id is loud.
      const result = stmts.get(`
        INSERT OR IGNORE INTO raw_posts (${COLUMNS})
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        post.sourceId,
        post.sourcePostId,
        post.originalUrl,
        post.author,
        post.text,
        post.eventTime,
        post.ingestionTime,
        toJson(post.meta ?? {}),
        nowIso(),
      );
      return result.changes > 0 ? id : null;
    },

    exists(sourceId: string, sourcePostId: string): boolean {
      const row = stmts
        .get<{ one: number }>(
          'SELECT 1 AS one FROM raw_posts WHERE source_id = ? AND source_post_id = ? LIMIT 1',
        )
        .get(sourceId, sourcePostId);
      return row !== undefined;
    },

    byId(id: string): RawPost | null {
      const row = stmts.get<RawPostRow>(`SELECT ${COLUMNS} FROM raw_posts WHERE id = ?`).get(id);
      return row ? toRawPost(row) : null;
    },

    recent(limit: number): RawPost[] {
      const capped = Math.max(1, Math.min(Math.trunc(limit) || 1, 5000));
      return stmts
        .get<RawPostRow>(`SELECT ${COLUMNS} FROM raw_posts ORDER BY event_time DESC LIMIT ?`)
        .all(capped)
        .map(toRawPost);
    },
  };
}
