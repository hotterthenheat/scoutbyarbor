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
             error = excluded.error`,
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
