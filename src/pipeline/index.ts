import type {
  Category,
  EventCluster,
  ExtractedEntities,
  NewsEvent,
  NormalizedPost,
  PipelineOutcome,
  RawChannelPayload,
  RawPost,
  RejectionReason,
  Security,
  Source,
  TickerMatch,
} from '../core/types.js';
import type { TaxonomyFile } from '../config/types.js';
import type { SourceAttribution } from '../core/provenance.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';

import { normalizePost } from './normalize.js';
import { detectDuplicate } from './dedupe.js';
import { createTickerExtractor } from './extract/tickers.js';
import { createEntityExtractor } from './extract/entities.js';
import { createCategoryClassifier } from './classify/category.js';
import { createNoiseClassifier } from './classify/noise.js';
import { createFactualityClassifier } from './classify/factuality.js';
import { extractEarnings, isEarningsPost, buildEarningsHeadline } from './classify/earnings.js';
import { classifyFiling } from './classify/filings.js';
import { identifySubject } from './classify/subject.js';
import { findCluster, createCluster, applyUpdate, computeNovelty } from './cluster.js';
import { scoreEvent } from './score.js';
import { assessMarketImpact } from './marketImpact.js';
import { routeAlert } from '../discord/router.js';
import { buildAlert } from '../render/alert.js';
import { computeLatency } from '../health/latency.js';
import {
  provenanceOf,
  provenanceFromSourceIds,
  attributionFrom,
  mergeAttribution,
} from '../core/provenance.js';
import { newId, deterministicId } from '../util/id.js';
import { msBetween } from '../util/time.js';

/**
 * The pipeline (§2):
 *
 *   NORMALIZE → DEDUPLICATE → CLASSIFY → FILTER → CLUSTER → RANK → FORMAT
 *
 * One post in, one PipelineOutcome out. Every rejection is recorded rather than
 * dropped on the floor, because #scout-raw and the source-quality report are
 * both built out of the rejections (§27, §28).
 *
 * Nothing here talks to Discord — the caller publishes. That keeps the whole
 * decision path testable without a gateway connection.
 */

export interface PipelineConfig {
  categoryChannelsEnabled?: boolean;
  /** How old a story may be and still publish, in minutes. 0 disables it. */
  maxPublishAgeMinutes?: number;
  minPublishScore: number;
  minBreakingScore: number;
  dedupeWindowMinutes: number;
  clusterWindowMinutes: number;
  dedupeSimilarity: number;
}

export interface PipelineDeps {
  db: ScoutDb;
  taxonomy: TaxonomyFile;
  securities: Security[];
  config: PipelineConfig;
  logger: Logger;
  now?: () => Date;
}

export interface Pipeline {
  process(raw: RawPost): Promise<PipelineOutcome>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { db, taxonomy, securities, config, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const tickerExtractor = createTickerExtractor({
    securities,
    stopwords: taxonomy.tickerStopwords,
  });
  const entityExtractor = createEntityExtractor({ taxonomy, tickers: tickerExtractor });
  const categoryClassifier = createCategoryClassifier(taxonomy);
  const noiseClassifier = createNoiseClassifier(taxonomy);
  const factualityClassifier = createFactualityClassifier(taxonomy);

  async function process(raw: RawPost): Promise<PipelineOutcome> {
    const startedAt = now();
    const source = db.sources.byId(raw.sourceId);
    const signals: string[] = [];

    // Who reported this, in enough detail to name the actual feed rather than
    // the platform. Built once and reused wherever the cluster records origins.
    const attribution = attributionFrom({
      sourceId: raw.sourceId,
      sourceName: source?.name ?? null,
      author: raw.author,
      publishedAt: typeof raw.meta.publishedAt === 'string' ? raw.meta.publishedAt : null,
      org: source?.org ?? null,
      meta: raw.meta,
    });

    // ── NORMALIZE ───────────────────────────────────────────────────────────
    const post = normalizePost(raw, { now });

    const ctx: BuildContext = {
      raw,
      post,
      attribution,
      source,
      entities: emptyEntities(),
      category: null,
      subcategory: null,
      cluster: null,
      signals,
      startedAt,
      now,
    };

    if (!source || !source.enabled) {
      return reject(ctx, 'SOURCE_DISABLED', db, config);
    }
    if (!post.cleanText.trim()) {
      return reject(ctx, 'EMPTY_TEXT', db, config);
    }

    // ── DEDUPLICATE (§17) ───────────────────────────────────────────────────
    // Runs before classification so a wire that has already been reported costs
    // nothing further to reject.
    const dedupeSince = new Date(
      startedAt.getTime() - config.dedupeWindowMinutes * 60_000,
    ).toISOString();
    const candidates = db.newsEvents.dedupeCandidates(dedupeSince);
    const dup = detectDuplicate({
      post,
      candidates,
      similarityThreshold: config.dedupeSimilarity,
      windowMinutes: config.dedupeWindowMinutes,
      now: startedAt.toISOString(),
    });
    signals.push(...dup.signals);

    if (dup.isDuplicate) {
      // A duplicate still counts as corroboration for the cluster it matched —
      // more independent sources on the same story raises credibility (§19).
      if (dup.matchedEventId) {
        const cluster = db.events.byId(dup.matchedEventId);
        if (cluster) {
          // Corroboration counts distinct wires. A source reposting its own
          // headline must not inflate the credibility of the event, so this
          // checks actual membership rather than guessing from timing.
          const sourceIds = new Set(cluster.sourceIds ?? []);
          if (!sourceIds.has(source.id)) {
            sourceIds.add(source.id);
            cluster.sourceIds = [...sourceIds];
            cluster.sourceCount = sourceIds.size;
          }
          // The same merge either way: a source repeating itself refines its own
          // record (an earlier report time) rather than counting twice.
          cluster.contributors = mergeAttribution(cluster.contributors ?? [], attribution);
          cluster.postCount += 1;
          cluster.lastUpdatedAt = startedAt.toISOString();
          db.events.update(cluster);
        }
        ctx.cluster = cluster;
      }
      db.sources.bumpStat(source.id, 'duplicates');

      const isCurated = source.sourceType === 'manual';
      if (!isCurated) {
        return reject(ctx, dup.reason ?? 'DUPLICATE_TEXT', db, config);
      }
    }

    // ── CLASSIFY (§4, §25) ──────────────────────────────────────────────────
    const entities = entityExtractor.extract(post.cleanText, raw.meta);
    ctx.entities = entities;

    const verdict = categoryClassifier.classify({
      text: post.cleanText,
      tokens: post.tokens,
      entities,
      sourceCategory: source.category,
      isCurated: source.sourceType === 'manual',
    });

    if (!verdict) {
      return reject(ctx, 'NO_CATEGORY', db, config);
    }
    ctx.category = verdict.category;
    ctx.subcategory = verdict.subcategory;
    signals.push(...verdict.signals);

    // ── FILTER (§20, §8) ────────────────────────────────────────────────────
    const noise = noiseClassifier.classify({
      text: post.cleanText,
      tokens: post.tokens,
      isEcho: post.isEcho,
      sourceQuality: source.qualityScore,
      filterProfile: source.filterProfile,
    });
    signals.push(...noise.signals);

    if (noise.isNoise) {
      if (source.sourceType !== 'manual') {
        return reject(ctx, noise.reason ?? 'NOISE_COMMENTARY', db, config);
      }
    }

    const factuality = factualityClassifier.classify({
      text: post.cleanText,
      tokens: post.tokens,
      hasFigures: entities.figures.length > 0,
      isOfficial: source.official,
    });
    signals.push(...factuality.signals);

    // §8: on accounts that mix reporting with opinion, commentary does not pass.
    if (source.filterProfile === 'strict' && factuality.verdict === 'COMMENTARY') {
      if (source.sourceType !== 'manual') {
        return reject(ctx, 'NOISE_COMMENTARY', db, config);
      }
    }

    // ── ENRICH: earnings (§15) and filings (§16) ────────────────────────────
    let earnings = null;
    let headline = post.headline;
    let category: Category = verdict.category;

    if (verdict.category === 'EARNINGS' || isEarningsPost(post.cleanText)) {
      earnings = extractEarnings({
        text: post.cleanText,
        tickers: entities.tickers,
        figures: entities.figures,
      });
      if (earnings) {
        category = 'EARNINGS';
        headline = buildEarningsHeadline(earnings, post.headline);
        signals.push('earnings:parsed');
      }
    }

    let filing = null;
    if (raw.meta && typeof raw.meta.form === 'string') {
      filing = classifyFiling({
        form: raw.meta.form,
        items: Array.isArray(raw.meta.items) ? (raw.meta.items as string[]) : [],
        title: typeof raw.meta.title === 'string' ? raw.meta.title : post.headline,
        company: typeof raw.meta.company === 'string' ? raw.meta.company : '',
        ticker: entities.tickers[0]?.ticker ?? null,
        cik: typeof raw.meta.cik === 'string' ? raw.meta.cik : '',
        filedAt: raw.eventTime,
        accessionNumber:
          typeof raw.meta.accessionNumber === 'string' ? raw.meta.accessionNumber : null,
      });
      signals.push(...filing.materialitySignals);

      // §16: most filings never alert. Only CRITICAL/HIGH reach a channel.
      if (filing.materiality !== 'CRITICAL' && filing.materiality !== 'HIGH') {
        ctx.category = category;
        return reject(ctx, 'FILING_IMMATERIAL', db, config);
      }
    }

    // A single-name category has to name the single name (§20).
    //
    // Checked BEFORE clustering on purpose. An unusable event that opens a
    // cluster goes on to absorb the real coverage that follows it, and the
    // first headline is the one a cluster keeps — so a story Scout could not
    // identify would end up captioning the story it could.
    const subject = identifySubject({
      category,
      entities,
      filing: {
        company: typeof raw.meta.company === 'string' ? raw.meta.company : undefined,
        cik: typeof raw.meta.cik === 'string' ? raw.meta.cik : undefined,
      },
    });
    signals.push(subject.reason);
    if (!subject.identified) {
      ctx.category = category;
      return reject(ctx, 'NO_IDENTIFIED_SUBJECT', db, config);
    }

    // ── CLUSTER (§18) ───────────────────────────────────────────────────────
    const clusterSince = new Date(
      startedAt.getTime() - config.clusterWindowMinutes * 60_000,
    ).toISOString();
    const openClusters = db.events.openSince(clusterSince);
    const match = findCluster({
      post: { ...post, headline },
      category,
      entities,
      openClusters,
      windowMinutes: config.clusterWindowMinutes,
      similarityThreshold: config.dedupeSimilarity,
      now: startedAt.toISOString(),
    });
    signals.push(...match.reasons);

    const novelty = computeNovelty({
      matchedCluster: match.cluster,
      similarity: match.similarity,
      minutesSinceFirstSeen: match.cluster
        ? msBetween(match.cluster.firstSeenAt, startedAt.toISOString()) / 60_000
        : 0,
      sourceCount: match.cluster?.sourceCount ?? 0,
    });

    // ── RANK (§19) ──────────────────────────────────────────────────────────
    const score = scoreEvent({
      source,
      category,
      subcategory: verdict.subcategory,
      entities,
      text: post.cleanText,
      tokens: post.tokens,
      factuality,
      noise,
      magnitudeTerms: taxonomy.magnitude,
      novelty,
      corroboratingSources: match.cluster?.sourceCount ?? 0,
      securities,
      filing,
      earnings,
    });
    signals.push(...score.notes);

    if (score.total < config.minPublishScore) {
      ctx.category = category;
      return reject(ctx, 'BELOW_THRESHOLD', db, config, score);
    }

    // Age, checked LAST — after scoring, so the decision is recorded against a
    // fully classified event rather than thrown away early.
    //
    // The freshness rule used to gate only the Sprout hand-off, so a story
    // published twenty minutes ago still arrived as an alert carrying its own
    // twenty-minute-old timestamp. That reads as a bot running behind rather
    // than a wire running fast, and on a trading desk it is worse than that:
    // the move already happened.
    //
    // Publication time is read with NO fallback. Unknown stays publishable —
    // refusing everything a source failed to timestamp would silently drop
    // whole feeds — but a KNOWN and old time is declined.
    const maxAgeMinutes = config.maxPublishAgeMinutes ?? 0;
    const statedAt = typeof raw.meta.publishedAt === 'string' ? raw.meta.publishedAt : null;
    if (maxAgeMinutes > 0 && statedAt) {
      const ageMs = startedAt.getTime() - Date.parse(statedAt);
      if (Number.isFinite(ageMs) && ageMs > maxAgeMinutes * 60_000) {
        signals.push(`published ${Math.round(ageMs / 60_000)}m ago, limit ${maxAgeMinutes}m`);
        if (source.sourceType !== 'manual') {
          ctx.category = category;
          return reject(ctx, 'NOISE_OLD_NEWS', db, config, score);
        }
      }
    }

    // Attach to (or open) the cluster now that we know the post is publishable.
    let cluster: EventCluster;
    let isNewCluster = false;
    let supersedes = false;

    if (match.cluster) {
      const applied = applyUpdate(match.cluster, {
        headline,
        importance: score.total,
        band: score.band,
        sourceId: source.id,
        occurredAt: raw.eventTime,
        tickers: entities.tickers.map((t) => t.ticker),
        countries: entities.countries,
      });
      cluster = applied.cluster;
      supersedes = applied.supersedes;
      db.events.update(cluster);
    } else {
      cluster = createCluster({
        id: newId(),
        headline,
        category,
        subcategory: verdict.subcategory,
        tickers: entities.tickers.map((t) => t.ticker),
        countries: entities.countries,
        entities: [...entities.organizations, ...entities.people],
        importance: score.total,
        band: score.band,
        sourceId: source.id,
        attribution,
        occurredAt: raw.eventTime,
        now: startedAt.toISOString(),
      });
      isNewCluster = true;
      db.events.insert(cluster);
    }
    ctx.cluster = cluster;

    // ── FORMAT (§3, §26, §33) ───────────────────────────────────────────────
    // Whether this reaches the trading channels is decided by the event, never
    // by which account posted it.
    const impact = assessMarketImpact({
      category,
      subcategory: verdict.subcategory,
      band: score.band,
      score: score.total,
      entities,
      text: post.cleanText,
      securities,
    });
    signals.push(...impact.reasons.map((r) => `impact:${r}`));

    const route = routeAlert({
      category,
      secondary: verdict.secondary,
      band: score.band,
      score: score.total,
      minBreakingScore: config.minBreakingScore,
      subcategory: verdict.subcategory,
      tickers: entities.tickers.map((t) => t.ticker),
      impact,
      categoryChannelsEnabled: config.categoryChannelsEnabled,
    });

    const alert = buildAlert({
      banner: bannerFor(category),
      headline,
      timestampIso: raw.eventTime,
      // Only genuine additional prose. Falling back to cleanText here rendered
      // the headline twice for every single-line wire headline.
      body: post.body,
    });

    const processedAt = now().toISOString();
    const newsEvent = buildNewsEvent({
      ctx,
      headline,
      category,
      subcategory: verdict.subcategory,
      entities,
      score,
      novelty,
      confidence: verdict.confidence,
      status: 'PUBLISHED',
      rejection: null,
      earnings,
      filing,
      clusterId: cluster.id,
      processedAt,
    });
    db.newsEvents.insert(newsEvent);
    db.sources.bumpStat(source.id, 'posts_received');
    db.sources.bumpStat(source.id, 'posts_accepted');
    if (score.band === 'CRITICAL' || score.band === 'HIGH') {
      db.sources.bumpStat(source.id, 'material_events');
    }

    logger.info('accepted', {
      sourceId: source.id,
      category,
      score: score.total,
      band: score.band,
      cluster: cluster.id,
      supersedes,
    });

    return {
      newsEvent,
      accepted: true,
      rejection: null,
      cluster,
      isNewCluster,
      supersedes,
      route,
      alert,
      impact,
      raw: buildRawPayload(ctx, 'ACCEPTED', null, score, entities.tickers, signals),
      signals,
    };
  }

  return { process };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface BuildContext {
  raw: RawPost;
  attribution: SourceAttribution;
  post: NormalizedPost;
  source: Source | null;
  entities: ExtractedEntities;
  category: Category | null;
  subcategory: string | null;
  cluster: EventCluster | null;
  signals: string[];
  startedAt: Date;
  now: () => Date;
}

function reject(
  ctx: BuildContext,
  reason: RejectionReason,
  db: ScoutDb,
  _config: PipelineConfig,
  score: NewsEvent['score'] = null,
): PipelineOutcome {
  const status = reason.startsWith('DUPLICATE')
    ? 'DUPLICATE'
    : reason === 'BELOW_THRESHOLD'
      ? 'BELOW_THRESHOLD'
      : 'FILTERED';

  const processedAt = ctx.now().toISOString();
  const newsEvent = buildNewsEvent({
    ctx,
    headline: ctx.post.headline,
    category: ctx.category,
    subcategory: ctx.subcategory,
    entities: ctx.entities,
    score,
    novelty: 0,
    confidence: 0,
    status,
    rejection: reason,
    earnings: null,
    filing: null,
    clusterId: ctx.cluster?.id ?? null,
    processedAt,
  });

  // Rejections are stored, not discarded: the noise filter is only tunable if
  // its misses are on the record (§28).
  if (ctx.source) {
    db.newsEvents.insert(newsEvent);
    db.sources.bumpStat(ctx.source.id, 'posts_received');
    db.sources.bumpStat(ctx.source.id, 'posts_rejected');
  }

  return {
    newsEvent,
    accepted: false,
    rejection: reason,
    cluster: ctx.cluster,
    isNewCluster: false,
    supersedes: false,
    route: null,
    alert: null,
    impact: null,
    raw: buildRawPayload(
      ctx,
      status === 'DUPLICATE' ? 'DUPLICATE' : 'REJECTED',
      reason,
      score,
      ctx.entities.tickers,
      ctx.signals,
    ),
    signals: ctx.signals,
  };
}

function buildNewsEvent(args: {
  ctx: BuildContext;
  headline: string;
  category: Category | null;
  subcategory: string | null;
  entities: ExtractedEntities;
  score: NewsEvent['score'];
  novelty: number;
  confidence: number;
  status: NewsEvent['status'];
  rejection: RejectionReason | null;
  earnings: NewsEvent['earnings'];
  filing: NewsEvent['filing'];
  clusterId: string | null;
  processedAt: string;
}): NewsEvent {
  const { ctx } = args;
  const latency = computeLatency({
    eventTime: ctx.raw.eventTime,
    // Explicitly null when the source stated no publication time, so
    // source→Scout reports "no sample" rather than a fabricated 0ms.
    publishedAt: typeof ctx.raw.meta.publishedAt === 'string' ? ctx.raw.meta.publishedAt : null,
    ingestionTime: ctx.raw.ingestionTime,
    processingTime: args.processedAt,
    discordTime: null,
  });

  return {
    id: deterministicId(ctx.raw.sourceId, ctx.raw.sourcePostId),
    source: ctx.raw.sourceId,
    sourcePostId: ctx.raw.sourcePostId,
    originalUrl: ctx.raw.originalUrl,
    author: ctx.raw.author,
    timestamp: ctx.raw.eventTime,
    rawText: ctx.raw.text,
    cleanText: ctx.post.cleanText,
    headline: args.headline,
    body: ctx.post.body,
    category: args.category,
    subcategory: args.subcategory,
    entities: args.entities,
    tickers: args.entities.tickers.map((t) => t.ticker),
    countries: args.entities.countries,
    eventId: args.clusterId,
    importance: args.score?.total ?? 0,
    novelty: args.novelty,
    marketRelevance: args.score?.marketRelevance ?? 0,
    confidence: args.confidence,
    score: args.score,
    status: args.status,
    rejectionReason: args.rejection,
    earnings: args.earnings,
    filing: args.filing,
    createdAt: ctx.startedAt.toISOString(),
    processedAt: args.processedAt,
    discordMessageId: null,
    latency,
  };
}

function buildRawPayload(
  ctx: BuildContext,
  decision: RawChannelPayload['decision'],
  rejection: RejectionReason | null,
  score: NewsEvent['score'],
  tickers: TickerMatch[],
  signals: string[],
): RawChannelPayload {
  // From the cluster's contributors, so a story seen on both X and Discord names
  // both feeds rather than whichever arrived last. Clusters written before
  // contributors were stored fall back to what bare source ids support.
  const provenance =
    ctx.cluster?.contributors && ctx.cluster.contributors.length > 0
      ? provenanceOf(ctx.cluster.contributors)
      : ctx.cluster?.sourceIds && ctx.cluster.sourceIds.length > 0
        ? provenanceFromSourceIds(ctx.cluster.sourceIds)
        : provenanceOf([ctx.attribution]);

  return {
    sourceName: ctx.source?.name ?? ctx.raw.sourceId,
    provenance,
    handle: ctx.source?.handle ?? ctx.raw.author,
    originalUrl: ctx.raw.originalUrl,
    rawText: ctx.raw.text,
    eventTime: ctx.raw.eventTime,
    ingestionTime: ctx.raw.ingestionTime,
    category: ctx.category,
    subcategory: ctx.subcategory,
    decision,
    rejectionReason: rejection,
    score,
    tickers,
    signals,
    latencyMs: msBetween(ctx.raw.eventTime, ctx.raw.ingestionTime),
    eventId: ctx.cluster?.id ?? null,
  };
}

function bannerFor(category: Category): string {
  // CATEGORY_BANNER lives in core/types so the renderer and the pipeline agree.
  return `${category === 'OPTIONS' ? 'OPTIONS / FLOW' : category} ALERT`;
}

function emptyEntities(): ExtractedEntities {
  return {
    tickers: [],
    countries: [],
    organizations: [],
    people: [],
    commodities: [],
    figures: [],
  };
}
