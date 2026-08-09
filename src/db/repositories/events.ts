import type { Category, EventCluster, ImportanceBand } from '../../core/types.js';
import {
  createStatementCache,
  parseJsonArray,
  parseJsonObject,
  toJson,
  toNullableText,
  toNumber,
  toText,
  type Bind,
  type SqliteDatabase,
} from '../index.js';

/**
 * Clustered real-world events (§18). Many posts from many sources collapse into
 * one of these, and Discord shows the cluster — not each post.
 */
export interface EventRepo {
  insert(cluster: EventCluster): void;
  update(cluster: EventCluster): void;
  byId(id: string): EventCluster | null;
  /** Open clusters touched since `sinceIso` — the clustering window (§17). */
  openSince(sinceIso: string): EventCluster[];
  close(id: string): void;
}

interface EventRow {
  id: string;
  headline: string;
  category: string;
  subcategory: string | null;
  tickers: string;
  countries: string;
  entities: string;
  source_ids: string;
  slug: string;
  importance: number;
  band: string;
  source_count: number;
  post_count: number;
  first_seen_at: string;
  last_updated_at: string;
  status: string;
  discord_messages: string;
  created_at: string;
}

const COLUMNS = `
  id, slug, headline, category, subcategory, tickers, countries, entities, source_ids, importance,
  band, source_count, post_count, first_seen_at, last_updated_at, status,
  discord_messages, created_at`;

function toCluster(row: EventRow): EventCluster {
  return {
    id: row.id,
    headline: toText(row.headline),
    category: toText(row.category) as Category,
    subcategory: toNullableText(row.subcategory),
    tickers: parseJsonArray<string>(row.tickers),
    countries: parseJsonArray<string>(row.countries),
    entities: parseJsonArray<string>(row.entities),
    sourceIds: parseJsonArray<string>(row.source_ids),
    slug: toText(row.slug),
    importance: toNumber(row.importance),
    band: toText(row.band, 'LOW') as ImportanceBand,
    sourceCount: toNumber(row.source_count, 1),
    postCount: toNumber(row.post_count, 1),
    firstSeenAt: toText(row.first_seen_at),
    lastUpdatedAt: toText(row.last_updated_at),
    status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    discordMessages: parseJsonObject<Record<string, string>>(row.discord_messages, {}),
    createdAt: toText(row.created_at),
  };
}

function toParams(c: EventCluster): Bind[] {
  return [
    c.id,
    c.slug ?? '',
    c.headline,
    c.category,
    c.subcategory,
    toJson(c.tickers ?? []),
    toJson(c.countries ?? []),
    toJson(c.entities ?? []),
    toJson(c.sourceIds ?? []),
    c.importance,
    c.band,
    c.sourceCount,
    c.postCount,
    c.firstSeenAt,
    c.lastUpdatedAt,
    c.status,
    toJson(c.discordMessages ?? {}),
    c.createdAt,
  ];
}

export function createEventRepo(db: SqliteDatabase): EventRepo {
  const stmts = createStatementCache(db);

  return {
    insert(cluster: EventCluster): void {
      // Upsert on the primary key rather than OR REPLACE: REPLACE deletes the
      // old row first, and ON DELETE CASCADE would take the cluster's updates
      // and Discord message log with it.
      stmts.get(`
        INSERT INTO events (${COLUMNS})
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          headline = excluded.headline,
          category = excluded.category,
          subcategory = excluded.subcategory,
          tickers = excluded.tickers,
          countries = excluded.countries,
          entities = excluded.entities,
          source_ids = excluded.source_ids,
          importance = excluded.importance,
          band = excluded.band,
          source_count = excluded.source_count,
          post_count = excluded.post_count,
          last_updated_at = excluded.last_updated_at,
          status = excluded.status,
          discord_messages = excluded.discord_messages
      `).run(...toParams(cluster));
    },

    update(cluster: EventCluster): void {
      stmts.get(`
        UPDATE events SET
          slug = ?, headline = ?, category = ?, subcategory = ?, tickers = ?, countries = ?,
          entities = ?, source_ids = ?, importance = ?, band = ?, source_count = ?, post_count = ?,
          first_seen_at = ?, last_updated_at = ?, status = ?, discord_messages = ?
        WHERE id = ?
      `).run(
        cluster.slug ?? '',
        cluster.headline,
        cluster.category,
        cluster.subcategory,
        toJson(cluster.tickers ?? []),
        toJson(cluster.countries ?? []),
        toJson(cluster.entities ?? []),
        toJson(cluster.sourceIds ?? []),
        cluster.importance,
        cluster.band,
        cluster.sourceCount,
        cluster.postCount,
        cluster.firstSeenAt,
        cluster.lastUpdatedAt,
        cluster.status,
        toJson(cluster.discordMessages ?? {}),
        cluster.id,
      );
    },

    byId(id: string): EventCluster | null {
      const row = stmts.get<EventRow>(`SELECT ${COLUMNS} FROM events WHERE id = ?`).get(id);
      return row ? toCluster(row) : null;
    },

    openSince(sinceIso: string): EventCluster[] {
      return stmts
        .get<EventRow>(`
          SELECT ${COLUMNS} FROM events
           WHERE status = 'OPEN' AND last_updated_at >= ?
           ORDER BY last_updated_at DESC
        `)
        .all(sinceIso)
        .map(toCluster);
    },

    close(id: string): void {
      // last_updated_at is left alone: it is the cluster's activity clock and
      // closing is not activity.
      stmts.get(`UPDATE events SET status = 'CLOSED' WHERE id = ?`).run(id);
    },
  };
}
