import { createStatementCache, toNullableText, toNumber, toText, type SqliteDatabase } from '../index.js';

/**
 * Per-destination delivery log. A partial failure — Discord accepted three
 * channels and rejected the fourth — has to be visible rather than silent, and
 * this is also where Sprout's delivery status lives.
 */

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface DeliveryRecord {
  eventId: string;
  destination: string;
  status: DeliveryStatus;
  discordMessageId: string | null;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface DeliveryRepo {
  record(entry: DeliveryRecord): void;
  forEvent(eventId: string): DeliveryRecord[];
  countsByStatus(sinceIso: string): Record<string, number>;
  failed(limit: number): DeliveryRecord[];
  /** Targeted lookup for the replay command. */
  find(query: DeliveryQuery): DeliveryRecord[];
  /**
   * Atomically claims matching rows for one replay run and returns only those
   * this caller actually won. Two concurrent runs therefore work on disjoint
   * sets and can never deliver the same event twice.
   */
  claimForReplay(query: DeliveryQuery, claimant: string, staleClaimBefore: string, at: string): DeliveryRecord[];
  /** Hands a row back unprocessed, so the next run can pick it up immediately. */
  releaseClaim(eventId: string, destination: string): void;
}

export interface DeliveryQuery {
  destination: string;
  status?: DeliveryStatus;
  sinceIso?: string;
  /** Restrict to these event ids. */
  eventIds?: string[];
  limit?: number;
}

interface DeliveryRow {
  event_id: string;
  destination: string;
  status: string;
  discord_message_id: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

const COLUMNS = `event_id, destination, status, discord_message_id, sent_at, error, created_at`;

function toRecord(row: DeliveryRow): DeliveryRecord {
  return {
    eventId: row.event_id,
    destination: toText(row.destination),
    status: toText(row.status, 'PENDING') as DeliveryStatus,
    discordMessageId: toNullableText(row.discord_message_id),
    sentAt: toNullableText(row.sent_at),
    error: toNullableText(row.error),
    createdAt: toText(row.created_at),
  };
}

export function createDeliveryRepo(db: SqliteDatabase): DeliveryRepo {
  const stmts = createStatementCache(db);

  return {
    record(entry: DeliveryRecord): void {
      stmts
        .get(
          `INSERT INTO deliveries (${COLUMNS}) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(event_id, destination) DO UPDATE SET
             status = excluded.status,
             discord_message_id = excluded.discord_message_id,
             sent_at = excluded.sent_at,
             error = excluded.error,
             -- A recorded outcome ends the claim.
             claimed_at = NULL,
             claimed_by = NULL`,
        )
        .run(
          entry.eventId,
          entry.destination,
          entry.status,
          entry.discordMessageId,
          entry.sentAt,
          entry.error,
          entry.createdAt,
        );
    },

    forEvent(eventId: string): DeliveryRecord[] {
      return stmts
        .get<DeliveryRow>(`SELECT ${COLUMNS} FROM deliveries WHERE event_id = ?`)
        .all(eventId)
        .map(toRecord);
    },

    countsByStatus(sinceIso: string): Record<string, number> {
      const rows = stmts
        .get<{ status: string; n: number }>(
          `SELECT status, COUNT(*) AS n FROM deliveries WHERE created_at >= ? GROUP BY status`,
        )
        .all(sinceIso);
      const out: Record<string, number> = {};
      for (const row of rows) out[row.status] = toNumber(row.n);
      return out;
    },

    claimForReplay(
      query: DeliveryQuery,
      claimant: string,
      staleClaimBefore: string,
      at: string,
    ): DeliveryRecord[] {
      // better-sqlite3 is synchronous and a transaction takes a write lock, so
      // the select-then-claim below is atomic against another process sharing
      // the same database file.
      const claim = db.transaction((): DeliveryRecord[] => {
        const where: string[] = ['destination = ?', '(claimed_at IS NULL OR claimed_at < ?)'];
        const params: Array<string | number> = [query.destination, staleClaimBefore];

        if (query.status) {
          where.push('status = ?');
          params.push(query.status);
        }
        if (query.sinceIso) {
          where.push('created_at >= ?');
          params.push(query.sinceIso);
        }
        if (query.eventIds && query.eventIds.length > 0) {
          where.push(`event_id IN (${query.eventIds.map(() => '?').join(',')})`);
          params.push(...query.eventIds);
        }
        params.push(query.limit ?? 500);

        const rows = stmts
          .get<DeliveryRow>(
            `SELECT ${COLUMNS} FROM deliveries
              WHERE ${where.join(' AND ')}
              ORDER BY created_at ASC
              LIMIT ?`,
          )
          .all(...params);

        const won: DeliveryRecord[] = [];
        for (const row of rows) {
          const result = stmts
            .get(
              `UPDATE deliveries SET claimed_at = ?, claimed_by = ?
                WHERE event_id = ? AND destination = ?
                  AND (claimed_at IS NULL OR claimed_at < ?)`,
            )
            .run(at, claimant, row.event_id, query.destination, staleClaimBefore);
          // changes === 0 means another run claimed it between the select and
          // here; it is theirs, so skip it.
          if (result.changes > 0) won.push(toRecord(row));
        }
        return won;
      });

      return claim();
    },

    releaseClaim(eventId: string, destination: string): void {
      stmts
        .get(`UPDATE deliveries SET claimed_at = NULL, claimed_by = NULL
               WHERE event_id = ? AND destination = ?`)
        .run(eventId, destination);
    },

    find(query: DeliveryQuery): DeliveryRecord[] {
      const where: string[] = ['destination = ?'];
      const params: Array<string | number> = [query.destination];

      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.sinceIso) {
        where.push('created_at >= ?');
        params.push(query.sinceIso);
      }
      if (query.eventIds && query.eventIds.length > 0) {
        where.push(`event_id IN (${query.eventIds.map(() => '?').join(',')})`);
        params.push(...query.eventIds);
      }
      params.push(query.limit ?? 500);

      return stmts
        .get<DeliveryRow>(
          `SELECT ${COLUMNS} FROM deliveries
            WHERE ${where.join(' AND ')}
            ORDER BY created_at ASC
            LIMIT ?`,
        )
        .all(...params)
        .map(toRecord);
    },

    failed(limit: number): DeliveryRecord[] {
      return stmts
        .get<DeliveryRow>(
          `SELECT ${COLUMNS} FROM deliveries WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit)
        .map(toRecord);
    },
  };
}
