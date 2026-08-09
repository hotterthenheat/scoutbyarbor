import type { SourceHealth, SourceHealthState } from '../../core/types.js';
import {
  createStatementCache,
  toNullableText,
  toNumber,
  toText,
  type SqliteDatabase,
} from '../index.js';

/** Liveness per source (§23) — a stale feed must never read as "no news". */
export interface SourceHealthRepo {
  upsert(health: SourceHealth): void;
  byId(sourceId: string): SourceHealth | null;
  all(): SourceHealth[];
}

interface SourceHealthRow {
  source_id: string;
  state: string;
  last_success_at: string | null;
  last_item_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  expected_interval_ms: number;
  updated_at: string;
}

const COLUMNS = `
  source_id, state, last_success_at, last_item_at, last_error_at, last_error,
  consecutive_failures, expected_interval_ms, updated_at`;

function toHealth(row: SourceHealthRow): SourceHealth {
  return {
    sourceId: row.source_id,
    state: toText(row.state, 'ACTIVE') as SourceHealthState,
    lastSuccessAt: toNullableText(row.last_success_at),
    lastItemAt: toNullableText(row.last_item_at),
    lastErrorAt: toNullableText(row.last_error_at),
    lastError: toNullableText(row.last_error),
    consecutiveFailures: toNumber(row.consecutive_failures),
    expectedIntervalMs: toNumber(row.expected_interval_ms, 900_000),
    updatedAt: toText(row.updated_at),
  };
}

export function createSourceHealthRepo(db: SqliteDatabase): SourceHealthRepo {
  const stmts = createStatementCache(db);

  return {
    upsert(health: SourceHealth): void {
      stmts.get(`
        INSERT INTO source_health (${COLUMNS})
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id) DO UPDATE SET
          state = excluded.state,
          last_success_at = excluded.last_success_at,
          last_item_at = excluded.last_item_at,
          last_error_at = excluded.last_error_at,
          last_error = excluded.last_error,
          consecutive_failures = excluded.consecutive_failures,
          expected_interval_ms = excluded.expected_interval_ms,
          updated_at = excluded.updated_at
      `).run(
        health.sourceId,
        health.state,
        health.lastSuccessAt,
        health.lastItemAt,
        health.lastErrorAt,
        health.lastError,
        health.consecutiveFailures,
        health.expectedIntervalMs,
        health.updatedAt,
      );
    },

    byId(sourceId: string): SourceHealth | null {
      const row = stmts
        .get<SourceHealthRow>(`SELECT ${COLUMNS} FROM source_health WHERE source_id = ?`)
        .get(sourceId);
      return row ? toHealth(row) : null;
    },

    all(): SourceHealth[] {
      return stmts
        .get<SourceHealthRow>(`SELECT ${COLUMNS} FROM source_health ORDER BY source_id ASC`)
        .all()
        .map(toHealth);
    },
  };
}
