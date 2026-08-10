import { z } from 'zod';
import type { DiscordMessageEnvelope } from '../ingest/discordIntel/types.js';

/**
 * `POST /webhook/discord` — the Discord intelligence intake.
 *
 * Deliberately a SEPARATE endpoint and a separate schema from
 * `POST /webhook/news`. The X contract is live and working; a Discord message
 * is a different shape (embeds, attachments, bot authors, channels), and
 * widening the X schema to fit it would put the working path at risk for no
 * benefit. Both converge immediately afterwards on the same processor.
 *
 * This module owns authentication input, validation and normalization only.
 * What happens to an accepted message is the existing pipeline's business.
 */

export const DISCORD_WEBHOOK_SCHEMA_VERSION = 1;

const embedSchema = z.object({
  title: z.string().max(1_000).nullable().optional(),
  description: z.string().max(8_000).nullable().optional(),
  url: z.string().max(2_048).nullable().optional(),
  timestamp: z.string().max(64).nullable().optional(),
  author: z.string().max(300).nullable().optional(),
  footer: z.string().max(1_000).nullable().optional(),
  fields: z
    .array(
      z.object({
        name: z.string().max(300).default(''),
        value: z.string().max(2_000).default(''),
      }),
    )
    .max(40)
    .optional(),
});

const attachmentSchema = z.object({
  id: z.string().max(40).nullable().optional(),
  filename: z.string().max(300).nullable().optional(),
  url: z.string().max(2_048).nullable().optional(),
  content_type: z.string().max(120).nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

const payloadSchema = z.object({
  v: z.number().int(),
  message_id: z.string().min(1).max(40),
  channel_id: z.string().min(1).max(40),
  channel_name: z.string().max(200).nullable().optional(),
  guild_id: z.string().max(40).nullable().optional(),
  author_id: z.string().max(40).nullable().optional(),
  author_name: z.string().min(1).max(200),
  is_bot: z.boolean().optional(),
  content: z.string().max(20_000).default(''),
  embeds: z.array(embedSchema).max(20).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  /** Explicitly nullable: a bridge may genuinely not know it. */
  timestamp: z.string().min(1).max(64).nullable().optional(),
  edited_timestamp: z.string().min(1).max(64).nullable().optional(),
});

export type DiscordWebhookPayload = z.infer<typeof payloadSchema>;

export type DiscordValidationResult =
  | { ok: true; envelope: DiscordMessageEnvelope }
  | { ok: false; status: 400; error: string };

export function validateDiscordPayload(
  body: unknown,
  receivedAt: string,
): DiscordValidationResult {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join('.') || 'payload';
    return { ok: false, status: 400, error: `invalid ${field}: ${first?.message ?? 'malformed'}` };
  }

  const data = parsed.data;

  if (data.v !== DISCORD_WEBHOOK_SCHEMA_VERSION) {
    return {
      ok: false,
      status: 400,
      error: `unsupported schema version ${data.v}; this build accepts v${DISCORD_WEBHOOK_SCHEMA_VERSION}`,
    };
  }

  const embeds = (data.embeds ?? []).map((e) => ({
    title: e.title ?? null,
    description: e.description ?? null,
    url: e.url ?? null,
    timestamp: e.timestamp ?? null,
    author: e.author ?? null,
    footer: e.footer ?? null,
    fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
  }));

  // A message with no content AND no embed text carries nothing to classify.
  // Rejecting it here keeps an empty alert from ever being possible.
  const hasText =
    data.content.trim().length > 0 ||
    embeds.some(
      (e) =>
        (e.title ?? '').trim() ||
        (e.description ?? '').trim() ||
        e.fields.some((f) => f.name.trim() || f.value.trim()),
    );
  if (!hasText) {
    return { ok: false, status: 400, error: 'message has no content and no embed text' };
  }

  // A supplied timestamp must be real; a missing one is legitimate and becomes
  // null. Receipt time is never substituted — see normalize.publicationTimeOf.
  const timestamp = validateOptionalTime(data.timestamp, receivedAt);
  if (timestamp.error) return { ok: false, status: 400, error: `timestamp: ${timestamp.error}` };

  const edited = validateOptionalTime(data.edited_timestamp, receivedAt);
  if (edited.error) {
    return { ok: false, status: 400, error: `edited_timestamp: ${edited.error}` };
  }

  for (const [index, embed] of embeds.entries()) {
    if (embed.timestamp === null) continue;
    const check = validateOptionalTime(embed.timestamp, receivedAt);
    if (check.error) {
      return { ok: false, status: 400, error: `embeds.${index}.timestamp: ${check.error}` };
    }
    embed.timestamp = check.value;
  }

  return {
    ok: true,
    envelope: {
      messageId: data.message_id.trim(),
      channelId: data.channel_id.trim(),
      channelName: data.channel_name?.trim() || null,
      guildId: data.guild_id?.trim() || null,
      authorId: data.author_id?.trim() || null,
      authorName: data.author_name.trim(),
      isBot: data.is_bot ?? false,
      content: data.content,
      embeds,
      attachments: (data.attachments ?? []).map((a) => ({
        id: a.id ?? null,
        filename: a.filename ?? null,
        url: a.url ?? null,
        contentType: a.content_type ?? null,
        size: a.size ?? null,
      })),
      timestamp: timestamp.value,
      editedTimestamp: edited.value,
      receivedAt,
    },
  };
}

/** An hour of clock skew is tolerated; beyond that the timestamp is wrong. */
function validateOptionalTime(
  value: string | null | undefined,
  receivedAt: string,
): { value: string | null; error?: string } {
  if (value === undefined || value === null) return { value: null };

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { value: null, error: 'not a valid timestamp' };
  if (ms > Date.parse(receivedAt) + 60 * 60_000) {
    return { value: null, error: 'is in the future' };
  }
  return { value: new Date(ms).toISOString() };
}
