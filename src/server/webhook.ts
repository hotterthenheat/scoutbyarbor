import { createHash, timingSafeEqual } from 'node:crypto';

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



function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}
