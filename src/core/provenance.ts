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

export type Origin = 'x' | 'discord' | 'rss' | 'edgar' | 'wire' | 'other';

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
  /**
   * The account that carried the message the last hop into Scout, when that is
   * NOT the source. A forwarding bot is transport; recording it here rather
   * than in `author` is what stops it being read as the byline.
   */
  relayedBy?: string;
  /**
   * False when a relay dropped the original author. The event is still real and
   * still worth publishing — Scout simply cannot say who said it, and says so
   * instead of crediting whoever forwarded it.
   */
  attributionPreserved?: boolean;
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
  // An aggregator carries other outlets' reporting. The origin is the wire it
  // came over; WHO reported it is the publisher, recorded separately below.
  if (id.startsWith('finnhub:')) return 'wire';
  return 'other';
}

const ORDER: Origin[] = ['x', 'discord', 'rss', 'edgar', 'wire', 'other'];

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
    // A message forwarded into an intake channel has two accounts attached: the
    // one that originally said it and the one that carried it here. Only the
    // first is a source. `originAuthor` is set exactly when the original
    // survived the hop, so preferring it — and refusing to fall back to the
    // carrier when it is absent — is what keeps a forwarding bot out of the
    // byline. `attributionPreserved: false` is a real answer, not a gap to fill.
    const preserved = meta.attributionPreserved !== false;
    const relayedBy = str(meta.carrierName);
    const author = preserved
      ? (str(meta.originAuthor) ?? (meta.relayed ? undefined : str(meta.authorName)) ?? str(input.author))
      : undefined;
    // The origin's channel and server, not Scout's mailbox.
    const channel = str(meta.originChannel) ?? str(meta.channelName) ?? str(meta.channelId);
    const server = str(meta.originServer) ?? str(meta.guildId);

    return {
      kind,
      sourceId: input.sourceId,
      ...(input.org ? { org: input.org } : {}),
      // The feed that actually said it. That is the thing worth naming — and
      // when nothing said it, the label says "unattributed" out loud.
      label:
        author ??
        (preserved
          ? (channel ?? input.sourceName ?? input.sourceId)
          : relayedBy
            ? `unattributed via ${relayedBy}`
            : 'unattributed'),
      ...(server ? { server } : {}),
      ...(channel ? { channel } : {}),
      ...(author ? { author } : {}),
      ...(relayedBy ? { relayedBy } : {}),
      ...(preserved ? {} : { attributionPreserved: false }),
      ...(input.publishedAt ? { firstSeenAt: input.publishedAt } : {}),
    };
  }

  // An aggregator names the outlet that actually reported the story. Labelling
  // it "Finnhub" would name the pipe rather than the reporter — the same
  // mistake as crediting a forwarding bot — and would make CNBC and Reuters
  // reporting one story look like one source reporting twice.
  const publisher = str(meta.publisher);
  if (kind === 'wire' && publisher) {
    return {
      kind,
      sourceId: input.sourceId,
      // Corroboration counts OUTLETS, so the publisher is the identity. The
      // aggregator's own id would collapse every story it carries into one.
      ...(str(meta.publisherOrg) ? { org: str(meta.publisherOrg)! } : {}),
      label: publisher,
      account: publisher,
      relayedBy: input.sourceName ?? input.sourceId,
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
  match.relayedBy ??= incoming.relayedBy;

  // The same story arriving a second time WITH its attribution intact upgrades
  // an earlier "unattributed" record. Learning who said it is new information;
  // discarding it to preserve the first, emptier answer would be perverse.
  if (match.attributionPreserved === false && incoming.attributionPreserved !== false && incoming.author) {
    delete match.attributionPreserved;
    match.author = incoming.author;
    match.label = incoming.label;
  }
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
