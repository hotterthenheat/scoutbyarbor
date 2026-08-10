/**
 * Where an event came from.
 *
 * Scout collapses the same story reported five ways into one event, and once it
 * has done that "which source was this" stops having a single answer. A CPI
 * print relayed on X and posted by a Discord bot is ONE event with TWO origins,
 * and that is worth knowing: an event corroborated across independent sources
 * is a different thing from one seen once.
 *
 * Derived from source ids rather than stored, so it cannot drift out of sync
 * with the cluster it describes.
 */

export type Origin = 'x' | 'discord' | 'rss' | 'edgar' | 'other';

export interface Provenance {
  origins: Origin[];
  /** Human-readable, for #scout-raw: "X", "DISCORD", "X + DISCORD". */
  label: string;
  /** More than one independent origin saw this story. */
  corroborated: boolean;
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

export function provenanceOf(sourceIds: readonly string[]): Provenance {
  const origins = new Set<Origin>();
  for (const id of sourceIds) {
    if (id?.trim()) origins.add(originOf(id));
  }

  const ordered = ORDER.filter((o) => origins.has(o));
  return {
    origins: ordered,
    label: ordered.length === 0 ? 'UNKNOWN' : ordered.map((o) => o.toUpperCase()).join(' + '),
    corroborated: ordered.length > 1,
  };
}
