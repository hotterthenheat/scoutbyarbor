import { createStatementCache, toNullableText, toText, type SqliteDatabase } from '../index.js';
import type { ResolvedPost } from '../../ingest/resolver.js';

/**
 * Resolved posts, keyed by canonical id (`x:<post_id>`).
 *
 * `published_at` is nullable on purpose. When the genuine publication time is
 * unavailable it stays NULL — the Discord receive time is stored separately and
 * never promoted into it, because a stale headline must not be able to look
 * like fresh news to anything downstream.
 */

export interface StoredPost extends ResolvedPost {
  /** Platform the post came from, when known. */
  platform: string | null;
  /** Upstream relay/service that delivered it — not the original account. */
  upstreamSource: string | null;
  /** When Scout received it. Never promoted into publishedAt. */
  receivedAt: string | null;
  discordReceivedAt: string | null;
  createdAt: string;
}

export interface PostRepo {
  upsert(post: StoredPost): void;
  byId(postId: string): StoredPost | null;
  exists(postId: string): boolean;
  /** Most recent receipt time for a retrieval source, for health reporting. */
  lastReceivedAt(retrievalSource: string): string | null;
  recent(limit: number): StoredPost[];
}

interface PostRow {
  post_id: string;
  author: string | null;
  author_handle: string | null;
  text: string;
  published_at: string | null;
  canonical_url: string | null;
  retrieval_source: string;
  platform: string | null;
  upstream_source: string | null;
  received_at: string | null;
  discord_received_at: string | null;
  created_at: string;
}

const COLUMNS = `post_id, author, author_handle, text, published_at, canonical_url,
                 retrieval_source, platform, upstream_source, received_at,
                 discord_received_at, created_at`;

function toPost(row: PostRow): StoredPost {
  return {
    postId: row.post_id,
    author: toNullableText(row.author),
    authorHandle: toNullableText(row.author_handle),
    text: toText(row.text),
    publishedAt: toNullableText(row.published_at),
    canonicalUrl: toText(row.canonical_url),
    media: [],
    retrievalSource: toText(row.retrieval_source, 'unknown'),
    platform: toNullableText(row.platform),
    upstreamSource: toNullableText(row.upstream_source),
    receivedAt: toNullableText(row.received_at),
    discordReceivedAt: toNullableText(row.discord_received_at),
    createdAt: toText(row.created_at),
  };
}

export function createPostRepo(db: SqliteDatabase): PostRepo {
  const stmts = createStatementCache(db);

  return {
    upsert(post: StoredPost): void {
      stmts
        .get(
          `INSERT INTO posts (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(post_id) DO UPDATE SET
             author = excluded.author,
             author_handle = excluded.author_handle,
             text = excluded.text,
             published_at = COALESCE(excluded.published_at, posts.published_at),
             canonical_url = excluded.canonical_url,
             retrieval_source = excluded.retrieval_source,
             platform = COALESCE(excluded.platform, posts.platform),
             upstream_source = COALESCE(excluded.upstream_source, posts.upstream_source),
             received_at = COALESCE(posts.received_at, excluded.received_at)`,
        )
        .run(
          post.postId,
          post.author,
          post.authorHandle,
          post.text,
          post.publishedAt,
          post.canonicalUrl,
          post.retrievalSource,
          post.platform ?? null,
          post.upstreamSource ?? null,
          post.receivedAt ?? post.discordReceivedAt ?? null,
          post.discordReceivedAt,
          post.createdAt,
        );
    },

    byId(postId: string): StoredPost | null {
      const row = stmts.get<PostRow>(`SELECT ${COLUMNS} FROM posts WHERE post_id = ?`).get(postId);
      return row ? toPost(row) : null;
    },

    exists(postId: string): boolean {
      return Boolean(stmts.get(`SELECT 1 FROM posts WHERE post_id = ?`).get(postId));
    },

    lastReceivedAt(retrievalSource: string): string | null {
      const row = stmts
        .get<{ received_at: string | null }>(
          `SELECT received_at FROM posts WHERE retrieval_source = ?
            ORDER BY received_at DESC LIMIT 1`,
        )
        .get(retrievalSource);
      return toNullableText(row?.received_at);
    },

    recent(limit: number): StoredPost[] {
      return stmts
        .get<PostRow>(`SELECT ${COLUMNS} FROM posts ORDER BY created_at DESC LIMIT ?`)
        .all(limit)
        .map(toPost);
    },
  };
}
