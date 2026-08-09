import type { EventUpdate } from '../../core/types.js';
import {
  createStatementCache,
  fromSqliteBool,
  toNumber,
  toSqliteBool,
  toText,
  type SqliteDatabase,
} from '../index.js';

/** Developments within an existing cluster (§18). */
export interface EventUpdateRepo {
  insert(update: EventUpdate): void;
  /** Newest first. */
  forEvent(eventId: string, limit?: number): EventUpdate[];
}

interface EventUpdateRow {
  id: string;
  event_id: string;
  news_event_id: string;
  headline: string;
  body: string;
  occurred_at: string;
  importance: number;
  supersedes: number;
  created_at: string;
}

const COLUMNS = `
  id, event_id, news_event_id, headline, body, occurred_at, importance,
  supersedes, created_at`;

function toUpdate(row: EventUpdateRow): EventUpdate {
  return {
    id: row.id,
    eventId: row.event_id,
    newsEventId: row.news_event_id,
    headline: toText(row.headline),
    body: toText(row.body),
    occurredAt: toText(row.occurred_at),
    importance: toNumber(row.importance),
    supersedes: fromSqliteBool(row.supersedes),
    createdAt: toText(row.created_at),
  };
}

export function createEventUpdateRepo(db: SqliteDatabase): EventUpdateRepo {
  const stmts = createStatementCache(db);

  return {
    insert(update: EventUpdate): void {
      stmts.get(`
        INSERT INTO event_updates (${COLUMNS})
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          headline = excluded.headline,
          body = excluded.body,
          occurred_at = excluded.occurred_at,
          importance = excluded.importance,
          supersedes = excluded.supersedes
      `).run(
        update.id,
        update.eventId,
        update.newsEventId,
        update.headline,
        update.body ?? '',
        update.occurredAt,
        update.importance,
        toSqliteBool(update.supersedes),
        update.createdAt,
      );
    },

    forEvent(eventId: string, limit = 50): EventUpdate[] {
      const capped = Math.max(1, Math.min(Math.trunc(limit) || 1, 1000));
      return stmts
        .get<EventUpdateRow>(`
          SELECT ${COLUMNS} FROM event_updates
           WHERE event_id = ?
           ORDER BY occurred_at DESC
           LIMIT ?
        `)
        .all(eventId, capped)
        .map(toUpdate);
    },
  };
}
