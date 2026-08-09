import type {
  Category,
  EventCluster,
  ExtractedEntities,
  ImportanceBand,
  NormalizedPost,
} from '../core/types.js';
import { textSimilarity } from '../util/text.js';
import { headlineEquivalent } from './dedupe.js';

/**
 * EVENT CLUSTERING (§18).
 *
 * The spec's worked example is a negotiation unfolding over an hour:
 *
 *   10:02  Trump says talks are progressing.
 *   10:17  Iranian officials signal agreement.
 *   10:41  Axios reports agreement reached.
 *   11:03  Trump approval still pending.
 *
 * These are four developments in one event. Scout keeps them as one cluster and
 * lets the biggest development supersede the alert already on screen, rather
 * than posting four times.
 *
 * Everything here is pure — the caller owns persistence.
 */

/** Categories that can legitimately describe the same real-world event. */
const COMPATIBLE: Record<Category, Category[]> = {
  MACRO: ['MACRO', 'FED', 'ECONOMIC', 'MARKET'],
  FED: ['FED', 'MACRO', 'ECONOMIC'],
  ECONOMIC: ['ECONOMIC', 'MACRO', 'FED'],
  GEOPOLITICAL: ['GEOPOLITICAL', 'COMMODITY', 'MARKET'],
  MARKET: ['MARKET', 'MACRO', 'GEOPOLITICAL'],
  EQUITY: ['EQUITY', 'EARNINGS', 'OPTIONS'],
  EARNINGS: ['EARNINGS', 'EQUITY'],
  OPTIONS: ['OPTIONS', 'EQUITY'],
  COMMODITY: ['COMMODITY', 'GEOPOLITICAL'],
  CRYPTO: ['CRYPTO'],
};

/**
 * How much textual agreement is needed, by how much subject the two share.
 * Developments in one story are often worded nothing alike — "Trump says talks
 * are progressing" and "Iranian officials signal agreement" share no
 * vocabulary at all — so shared entities carry most of the weight and the text
 * bar drops accordingly.
 */
const FLOOR_NO_SHARED_ENTITY = 0.55;
const FLOOR_ONE_SHARED_ENTITY = 0.3;
const FLOOR_MANY_SHARED_ENTITIES = 0.12;
/** How much more important a development must be before it takes over. */
const SUPERSEDE_MARGIN = 5;

export interface FindClusterInput {
  post: NormalizedPost;
  category: Category;
  entities: ExtractedEntities;
  openClusters: EventCluster[];
  windowMinutes: number;
  similarityThreshold: number;
  now: string;
}

export function findCluster(input: FindClusterInput): {
  cluster: EventCluster | null;
  similarity: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const nowMs = Date.parse(input.now);
  const windowMs = input.windowMinutes * 60_000;
  const compatible = COMPATIBLE[input.category] ?? [input.category];

  const postEntities = strongEntitiesOf(input.entities);
  const postHeadline = headlineEquivalent(input.post.headline || input.post.cleanText);

  let best: { cluster: EventCluster; similarity: number; shared: number } | null = null;

  for (const cluster of input.openClusters) {
    if (cluster.status !== 'OPEN') continue;

    const age = nowMs - Date.parse(cluster.lastUpdatedAt);
    if (!Number.isFinite(age) || age > windowMs || age < -windowMs) continue;
    if (!compatible.includes(cluster.category)) continue;

    const clusterEntities = new Set<string>([
      ...cluster.tickers.map(upper),
      ...cluster.countries.map(upper),
      ...cluster.entities.map(upper),
    ]);

    let shared = 0;
    for (const e of postEntities) if (clusterEntities.has(e)) shared++;

    const similarity = textSimilarity(postHeadline, headlineEquivalent(cluster.headline));
    const floor =
      shared >= 2
        ? FLOOR_MANY_SHARED_ENTITIES
        : shared === 1
          ? FLOOR_ONE_SHARED_ENTITY
          : FLOOR_NO_SHARED_ENTITY;
    if (similarity < floor) continue;

    if (!best || shared > best.shared || (shared === best.shared && similarity > best.similarity)) {
      best = { cluster, similarity, shared };
    }
  }

  if (!best) {
    reasons.push('cluster:new');
    return { cluster: null, similarity: 0, reasons };
  }

  reasons.push(
    `cluster:match:${best.cluster.id}:sim=${best.similarity.toFixed(2)}:shared=${best.shared}`,
  );
  return { cluster: best.cluster, similarity: best.similarity, reasons };
}

export interface CreateClusterInput {
  id: string;
  headline: string;
  category: Category;
  subcategory: string | null;
  tickers: string[];
  countries: string[];
  entities: string[];
  importance: number;
  band: ImportanceBand;
  sourceId: string;
  occurredAt: string;
  now: string;
}

export function createCluster(input: CreateClusterInput): EventCluster {
  return {
    id: input.id,
    headline: input.headline,
    category: input.category,
    subcategory: input.subcategory,
    tickers: [...new Set(input.tickers.map(upper))],
    countries: [...new Set(input.countries.map(upper))],
    entities: [...new Set(input.entities.map(upper))],
    importance: input.importance,
    band: input.band,
    sourceCount: 1,
    // Tracked as a set so corroboration counts distinct wires, not repeat
    // posts from one of them (§19).
    sourceIds: [input.sourceId],
    postCount: 1,
    firstSeenAt: input.occurredAt,
    lastUpdatedAt: input.now,
    status: 'OPEN',
    discordMessages: {},
    createdAt: input.now,
  };
}

export interface ApplyUpdateInput {
  headline: string;
  importance: number;
  band: ImportanceBand;
  sourceId: string;
  occurredAt: string;
  tickers: string[];
  countries: string[];
}

/**
 * Folds a development into a cluster. `supersedes` is the signal the publisher
 * uses to EDIT the message already on screen instead of posting again.
 */
export function applyUpdate(
  cluster: EventCluster,
  input: ApplyUpdateInput,
): { cluster: EventCluster; supersedes: boolean } {
  const knownSources = new Set(cluster.sourceIds ?? []);
  knownSources.add(input.sourceId);

  const moreImportant = input.importance >= cluster.importance + SUPERSEDE_MARGIN;
  const differentStory = textSimilarity(
    headlineEquivalent(cluster.headline),
    headlineEquivalent(input.headline),
  ) < 0.5;
  const supersedes = moreImportant || (differentStory && input.importance >= cluster.importance);

  const next: EventCluster = {
    ...cluster,
    headline: supersedes ? input.headline : cluster.headline,
    // The cluster keeps its peak: a minor follow-up must not downgrade an event
    // that was critical when it broke.
    importance: Math.max(cluster.importance, input.importance),
    band: input.importance > cluster.importance ? input.band : cluster.band,
    tickers: [...new Set([...cluster.tickers, ...input.tickers.map(upper)])],
    countries: [...new Set([...cluster.countries, ...input.countries.map(upper)])],
    sourceIds: [...knownSources],
    sourceCount: knownSources.size,
    postCount: cluster.postCount + 1,
    lastUpdatedAt: input.occurredAt,
  };

  return { cluster: next, supersedes };
}

/**
 * NOVELTY (§19). 100 for a story nobody has carried yet, decaying with each
 * corroborating wire and with elapsed time, so the fifth report of the same
 * headline scores near zero.
 */
export function computeNovelty(input: {
  matchedCluster: EventCluster | null;
  similarity: number;
  minutesSinceFirstSeen: number;
  sourceCount: number;
}): number {
  if (!input.matchedCluster) return 100;

  const corroborationPenalty = Math.min(70, input.sourceCount * 18);
  const timePenalty = Math.min(20, Math.max(0, input.minutesSinceFirstSeen) * 0.25);
  // A development that reads quite differently from the cluster headline is
  // carrying new information, so it keeps more of its novelty.
  const divergenceCredit = Math.max(0, (1 - input.similarity) * 30);

  const value = 100 - corroborationPenalty - timePenalty + divergenceCredit;
  return clamp(value, 0, 100);
}

function strongEntitiesOf(entities: ExtractedEntities): Set<string> {
  const out = new Set<string>();
  for (const t of entities.tickers) if (t.confidence >= 0.8) out.add(upper(t.ticker));
  for (const c of entities.countries) out.add(upper(c));
  for (const o of entities.organizations) out.add(upper(o));
  for (const p of entities.people) out.add(upper(p));
  for (const c of entities.commodities) out.add(upper(c));
  return out;
}

function upper(s: string): string {
  return s.toUpperCase();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
