import { createStatementCache, toText, type SqliteDatabase } from '../index.js';

/**
 * Delivery log, so a development can edit the right message in the right
 * channel instead of posting a second alert (§18, §26).
 */
export interface DiscordMessageRow {
  id: string;
  eventId: string | null;
  newsEventId: string | null;
  channelKey: string;
  channelId: string;
  messageId: string;
  threadId: string | null;
  sentAt: string;
}

export interface DiscordMessageRepo {
  insert(record: DiscordMessageRow): void;
  forEvent(eventId: string): Array<{ channelKey: string; channelId: string; messageId: string }>;
  markEdited(id: string, at: string): void;
}

interface Row {
  id: string;
  event_id: string | null;
  news_event_id: string | null;
  channel_key: string;
  channel_id: string;
  message_id: string;
  thread_id: string | null;
  sent_at: string;
}

export function createDiscordMessageRepo(db: SqliteDatabase): DiscordMessageRepo {
  const stmts = createStatementCache(db);

  return {
    insert(record: DiscordMessageRow): void {
      // OR IGNORE on UNIQUE(channel_id, message_id): re-logging a delivery we
      // already know about is a no-op, not an error.
      stmts.get(`
        INSERT OR IGNORE INTO discord_messages
          (id, event_id, news_event_id, channel_key, channel_id, message_id, thread_id, sent_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        record.id,
        record.eventId ?? null,
        record.newsEventId ?? null,
        record.channelKey,
        record.channelId,
        record.messageId,
        record.threadId ?? null,
        record.sentAt,
      );
    },

    forEvent(eventId: string): Array<{ channelKey: string; channelId: string; messageId: string }> {
      return stmts
        .get<Row>(`
          SELECT id, event_id, news_event_id, channel_key, channel_id, message_id, thread_id, sent_at
            FROM discord_messages
           WHERE event_id = ?
           ORDER BY sent_at ASC
        `)
        .all(eventId)
        .map((row) => ({
          channelKey: toText(row.channel_key),
          channelId: toText(row.channel_id),
          messageId: toText(row.message_id),
        }));
    },

    markEdited(id: string, at: string): void {
      stmts.get('UPDATE discord_messages SET edited_at = ? WHERE id = ?').run(at, id);
    },
  };
}
