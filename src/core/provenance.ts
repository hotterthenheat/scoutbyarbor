/**
 * Where an event came from, in enough detail to be worth reading.
 *
 * Scout collapses the same story reported five ways into one event, and once it
 * has done that "which source was this" stops having a single answer. A CPI
 * print relayed on X and posted by a Discord bot is ONE event with TWO origins.
 *
 * "DISCORD" is not a useful answer to that. `OwlsKeyLevelsBot` is: it names the
 * feed that actually said it, which is the thing an operator judges. So each
 * contributor is recorded individually — kind, server, channel, author or
 * account, and when it first reported — and the compact label is built from
 * those rather than from the origin category.
 *
 * All of this is backend detail for `#scout-raw`. The alert itself is a
 * four-field `RenderableAlert` and structurally cannot carry any of it.
 */

export type Origin = 'x' | 'discord' | 'rss' | 'edgar' | 'other';

/** One source that contributed to an event. */
export interface SourceAttribution {
  kind: Origin;
  /** Scout's source id, e.g. `discord:flow-alerts` or `x:deltaone`. */
  sourceId: string;
  /**
   * The ORGANISATION behind the feed. `rss:bls-latest` and `x:bls` are two
   * channels of one agency: when BLS publishes CPI on both, that is one body
   * reporting once, not two independent confirmations. Corroboration counts
   * distinct organisations, so a story on the BLS feed and the BLS X account
   * reads "confirmed by 1", while the same story on BLS and @DeItaone reads 2.
   */
  org?: string;
  /** Short display name: `OwlsKeyLevelsBot`, `@DeItaone`, `Federal Reserve`. */
  label: string;
  /** X/Truth handle, when the origin has one. */
  account?: string;
  /** Discord guild id or configured name. */
  server?: string;
  /** Discord channel name, falling back to its id. */
  channel?: string;
  /** Discord message author — the bot or person that posted it. */
  author?: string;
  /** When this source reported it. Publication time when known. */
  firstSeenAt?: string;
}

export interface Provenance {
  origins: Origin[];
  /** `OwlsKeyLevelsBot + @DeItaone` — who said it, not what platform. */
  label: string;
  sources: SourceAttribution[];
  /** More than one independent source saw this story. */
  corroborated: boolean;
  /** How many distinct sources. What "Confirmed by: 2 sources" reports. */
  confirmedBy: number;
  /** The earliest report across all contributors, or null if none stated one. */
  firstReportedAt: string | null;
}

export function originOf(sourceId: string): Origin {
  const id = sourceId.trim().toLowerCase();
  if (id.startsWith('discord:')) return 'discord';
  // The URL relay carries X posts that arrived through a Discord channel. The
  // POST is still an X post — the relay is transport, not origin.
  if (id.startsWith('relay:')) return 'x';
  if (id.startsWith('x:')) return 'x';
  if (id.startsWith('rss:')) return 'rss';
  if (id.startsWith('edgar:')) return 'edgar';
  return 'other';
}

const ORDER: Origin[] = ['x', 'discord', 'rss', 'edgar', 'other'];

/**
 * Builds one contributor record from a post and the source row it came from.
 *
 * Reads Discord specifics out of `meta`, which the Discord normalizer fills and
 * every other adapter leaves alone — so this is one function, not a switch that
 * has to be extended for each source type.
 */
export function attributionFrom(input: {
  sourceId: string;
  sourceName?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  org?: string | null;
  meta?: Record<string, unknown>;
}): SourceAttribution {
  const kind = originOf(input.sourceId);
  const meta = input.meta ?? {};

  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  if (kind === 'discord') {
    const author = str(meta.authorName) ?? str(input.author);
    const channel = str(meta.channelName) ?? str(meta.channelId);
    return {
      kind,
      sourceId: input.sourceId,
      ...(input.org ? { org: input.org } : {}),
      // The feed that actually said it. That is the thing worth naming.
      label: author ?? channel ?? input.sourceName ?? input.sourceId,
      ...(str(meta.guildId) ? { server: str(meta.guildId)! } : {}),
      ...(channel ? { channel } : {}),
      ...(author ? { author } : {}),
      ...(input.publishedAt ? { firstSeenAt: input.publishedAt } : {}),
    };
  }

  const account = str(input.author) ?? str(meta.relayHandle);
  return {
    kind,
    sourceId: input.sourceId,
    ...(input.org ? { org: input.org } : {}),
    label: account ?? input.sourceName ?? originLabel(kind),
    ...(account ? { account } : {}),
    ...(input.publishedAt ? { firstSeenAt: input.publishedAt } : {}),
  };
}

function originLabel(kind: Origin): string {
  return kind.toUpperCase();
}

/** Merges a new contributor in, keeping the earliest report per source. */
export function mergeAttribution(
  existing: readonly SourceAttribution[],
  incoming: SourceAttribution,
): SourceAttribution[] {
  const out = existing.map((a) => ({ ...a }));
  // Matched on organisation, so the same body arriving through a second feed
  // enriches the existing record rather than appearing as a new confirmation.
  const match = out.find((a) => identityOf(a) === identityOf(incoming));

  if (!match) {
    out.push(incoming);
    return out;
  }

  // A source reporting the same story twice is not a second source, but it may
  // have reported it earlier than we first recorded.
  if (
    incoming.firstSeenAt &&
    (!match.firstSeenAt || Date.parse(incoming.firstSeenAt) < Date.parse(match.firstSeenAt))
  ) {
    match.firstSeenAt = incoming.firstSeenAt;
  }
  // Later detail fills gaps but never overwrites what is already known.
  match.author ??= incoming.author;
  match.channel ??= incoming.channel;
  match.server ??= incoming.server;
  match.account ??= incoming.account;
  return out;
}

/** One body may publish through several feeds; identity is org when it has one. */
function identityOf(source: SourceAttribution): string {
  return source.org ?? source.sourceId;
}

export function provenanceOf(sources: readonly SourceAttribution[]): Provenance {
  const origins = new Set<Origin>();
  for (const s of sources) origins.add(s.kind);
  const ordered = ORDER.filter((o) => origins.has(o));

  // Distinct ORGANISATIONS. The Fed publishing to its RSS feed and its X
  // account is one confirmation; the Fed and Walter Bloomberg is two.
  const bodies = new Set(sources.map(identityOf));

  const times = sources
    .map((s) => s.firstSeenAt)
    .filter((t): t is string => Boolean(t) && Number.isFinite(Date.parse(t!)))
    .sort();

  return {
    origins: ordered,
    label:
      sources.length === 0 ? 'UNKNOWN' : sources.map((s) => s.label).join(' + '),
    sources: sources.map((s) => ({ ...s })),
    corroborated: bodies.size > 1,
    confirmedBy: bodies.size,
    firstReportedAt: times[0] ?? null,
  };
}

/**
 * Back-compat for clusters recorded before contributors were stored: derive
 * what can be derived from bare source ids. Produces `X + DISCORD` rather than
 * named feeds, which is the best the old data supports.
 */
export function provenanceFromSourceIds(sourceIds: readonly string[]): Provenance {
  return provenanceOf(
    sourceIds
      .filter((id) => id?.trim())
      .map((id) => ({ kind: originOf(id), sourceId: id, label: originOf(id).toUpperCase() })),
  );
}
