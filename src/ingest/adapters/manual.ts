import type { IngestAdapter, IngestResult, RawPost, Source } from '../../core/types.js';
import { deterministicId } from '../../util/id.js';
import { isoNow } from '../../util/time.js';

/**
 * Manual submission adapter — the URL-ingestion path from §35's Phase 1, and
 * the seam the CLI uses to push a single item through the live pipeline.
 */

export interface ManualAdapter extends IngestAdapter {
  submit(
    sourceId: string,
    text: string,
    opts?: { url?: string; author?: string; eventTime?: string },
  ): RawPost;
  pending(): number;
}

export function createManualAdapter(): ManualAdapter {
  const queue: RawPost[] = [];

  return {
    type: 'manual',

    submit(sourceId, text, opts = {}): RawPost {
      const now = isoNow();
      const post: RawPost = {
        sourceId,
        sourcePostId: `manual-${deterministicId(sourceId, text, opts.url ?? '').slice(0, 16)}`,
        originalUrl: opts.url ?? null,
        author: opts.author ?? null,
        text,
        eventTime: opts.eventTime ?? now,
        ingestionTime: now,
        meta: { manual: true },
      };
      queue.push(post);
      return post;
    },

    pending(): number {
      return queue.length;
    },

    async poll(_sources: Source[]): Promise<IngestResult> {
      const posts = queue.splice(0, queue.length);
      return {
        posts,
        outcomes: posts.length
          ? [{ sourceId: posts[0]!.sourceId, ok: true, itemCount: posts.length, latencyMs: 0 }]
          : [],
      };
    },
  };
}

/** Parses an X post URL into its handle and id. */
export function parseXPostUrl(url: string): { handle: string; postId: string } | null {
  const m = /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/i.exec(url ?? '');
  if (!m?.[1] || !m[2]) return null;
  return { handle: m[1], postId: m[2] };
}
