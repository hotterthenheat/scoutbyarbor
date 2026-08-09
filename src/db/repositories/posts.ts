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
  discordReceivedAt: string | null;
  createdAt: string;
}

export interface PostRepo {
  upsert(post: StoredPost): void;
  byId(postId: string): StoredPost | null;
  exists(postId: string): boolean;
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
  discord_received_at: string | null;
  created_at: string;
}

const COLUMNS = `post_id, author, author_handle, text, published_at, canonical_url,
                 retrieval_source, discord_received_at, created_at`;

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
          `INSERT INTO posts (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(post_id) DO UPDATE SET
             author = excluded.author,
             author_handle = excluded.author_handle,
             text = excluded.text,
             published_at = COALESCE(excluded.published_at, posts.published_at),
             canonical_url = excluded.canonical_url,
             retrieval_source = excluded.retrieval_source`,
        )
        .run(
          post.postId,
          post.author,
          post.authorHandle,
          post.text,
          post.publishedAt,
          post.canonicalUrl,
          post.retrievalSource,
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

    recent(limit: number): StoredPost[] {
      return stmts
        .get<PostRow>(`SELECT ${COLUMNS} FROM posts ORDER BY created_at DESC LIMIT ?`)
        .all(limit)
        .map(toPost);
    },
  };
}
