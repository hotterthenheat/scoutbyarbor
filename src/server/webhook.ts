import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Platform } from '../ingest/urls.js';

/**
 * Webhook ingestion.
 *
 * An upstream source pushes already-retrieved posts straight into Scout. This
 * module owns only authentication, validation and normalization — everything
 * after that is the existing processor. There is deliberately no
 * webhook-specific classifier, router, renderer or Sprout path: a webhook event
 * and a Discord-relayed event become the same normalized event and are
 * indistinguishable downstream.
 *
 * The one thing that is never inferred is publication time. If the upstream
 * source does not know when a post was published, `publishedAt` stays null and
 * the receipt time is stored separately. Substituting one for the other is how
 * a day-old headline opens a fresh trading blackout.
 */

export const WEBHOOK_SCHEMA_VERSION = 1;

/** Platform strings an upstream source might reasonably send. */
const PLATFORM_ALIASES: Record<string, Platform> = {
  x: 'x',
  twitter: 'x',
  'x.com': 'x',
  truth_social: 'truthsocial',
  truthsocial: 'truthsocial',
  truth: 'truthsocial',
};

const payloadSchema = z.object({
  v: z.number().int(),
  id: z.string().min(1).max(200),
  platform: z.string().min(1).max(40),
  source: z.string().min(1).max(120),
  handle: z.string().min(1).max(120),
  text: z.string().min(1).max(20_000),
  // Explicitly nullable: an upstream source may genuinely not know it.
  published_at: z.string().min(1).max(64).nullable().optional(),
  url: z.string().min(1).max(2048),
});

export type WebhookPayload = z.infer<typeof payloadSchema>;

/** A validated webhook event, in Scout's own vocabulary. */
export interface NormalizedWebhookEvent {
  /** Dedupe key shared with the relay path: `x:<id>` / `truth:<id>`. */
  canonicalId: string;
  platform: Platform;
  /** The upstream relay/service that pushed this, for debugging. */
  upstreamSource: string;
  /** The original account, e.g. `@DeItaone`. */
  handle: string;
  text: string;
  /** Exactly as supplied, or null. NEVER the receipt time. */
  publishedAt: string | null;
  url: string;
  receivedAt: string;
}

export type ValidationResult =
  | { ok: true; event: NormalizedWebhookEvent }
  | { ok: false; status: 400; error: string };

/**
 * Constant-time secret comparison. Both sides are hashed first so the compare
 * is over fixed-length buffers and cannot leak the secret's length.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(provided ?? '').digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Extracts the presented secret from either supported mechanism. Returns null
 * when none was presented at all.
 */
export function presentedSecret(headers: Record<string, string | string[] | undefined>): string | null {
  const authorization = headerValue(headers, 'authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const direct = headerValue(headers, 'x-scout-token') ?? headerValue(headers, 'x-webhook-token');
  return direct?.trim() || null;
}

/** The idempotency key an upstream retry should carry. Falls back to the id. */
export function idempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  fallback: string,
): string {
  return headerValue(headers, 'x-idempotency-key')?.trim() || fallback;
}

/**
 * Normalizes the supplied event id to Scout's canonical form, so a post pushed
 * by webhook and the same post seen through the Discord relay collapse to one
 * event. `x-123`, `x:123` and a bare `123` with platform `x` all become
 * `x:123`.
 */
export function canonicalIdFromWebhook(rawId: string, platform: Platform): string {
  const prefix = platform === 'x' ? 'x' : 'truth';
  const trimmed = rawId.trim();

  // Longest alternative first: `truth` would otherwise match inside
  // `truth_social-987` and leave `social-987` behind.
  const withoutPrefix = trimmed.replace(/^(?:truth_social|truthsocial|truth|twitter|x)[-:_]/i, '');
  // A numeric provider id is what the relay path derives from a URL, so use it
  // whenever we have one; otherwise keep the upstream id as an opaque suffix.
  const digits = /^\d{1,25}$/.test(withoutPrefix) ? withoutPrefix : null;

  return `${prefix}:${digits ?? withoutPrefix.toLowerCase()}`;
}

export function validateWebhookPayload(body: unknown, receivedAt: string): ValidationResult {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join('.') || 'payload';
    return { ok: false, status: 400, error: `invalid ${field}: ${first?.message ?? 'malformed'}` };
  }

  const data = parsed.data;

  if (data.v !== WEBHOOK_SCHEMA_VERSION) {
    return {
      ok: false,
      status: 400,
      error: `unsupported schema version ${data.v}; this build accepts v${WEBHOOK_SCHEMA_VERSION}`,
    };
  }

  const platform = PLATFORM_ALIASES[data.platform.trim().toLowerCase()];
  if (!platform) {
    return { ok: false, status: 400, error: `unsupported platform "${data.platform}"` };
  }

  if (!data.text.trim()) {
    return { ok: false, status: 400, error: 'text must not be empty' };
  }

  if (!/^https?:\/\//i.test(data.url.trim())) {
    return { ok: false, status: 400, error: 'url must be an absolute http(s) URL' };
  }

  // A supplied timestamp must be real; a missing one is legitimate.
  let publishedAt: string | null = null;
  if (data.published_at !== undefined && data.published_at !== null) {
    const ms = Date.parse(data.published_at);
    if (!Number.isFinite(ms)) {
      return { ok: false, status: 400, error: 'published_at is not a valid timestamp' };
    }
    if (ms > Date.parse(receivedAt) + 60 * 60_000) {
      return { ok: false, status: 400, error: 'published_at is in the future' };
    }
    publishedAt = new Date(ms).toISOString();
  }

  return {
    ok: true,
    event: {
      canonicalId: canonicalIdFromWebhook(data.id, platform),
      platform,
      upstreamSource: data.source.trim(),
      handle: data.handle.trim().startsWith('@') ? data.handle.trim() : `@${data.handle.trim()}`,
      text: data.text.trim(),
      publishedAt,
      url: data.url.trim(),
      receivedAt,
    },
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}
