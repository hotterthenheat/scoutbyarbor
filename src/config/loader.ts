import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CATEGORIES } from '../core/types.js';
import type { Security, Source } from '../core/types.js';
import type { SourceConfigEntry, SourcesFile, TaxonomyFile } from './types.js';
import type {
  DiscordChannelConfig,
  DiscordDestinations,
  DiscordSourcesFile,
} from '../ingest/discordIntel/types.js';

/**
 * Loads the three on-disk configuration files. All three are hot-reloadable:
 * `reload()` re-reads from disk so an operator can add a source or a keyword
 * and have it take effect without a restart (§36).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = resolve(HERE, '../../config');

// ── sources.yaml ─────────────────────────────────────────────────────────────

const sourceEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  handle: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  sourceType: z.enum(['x', 'rss', 'edgar', 'manual', 'finnhub', 'truthsocial']),
  category: z.enum([...CATEGORIES, 'MIXED'] as [string, ...string[]]),
  priority: z.number().int().min(0).max(100),
  enabled: z.boolean(),
  qualityScore: z.number().min(0).max(100),
  noiseScore: z.number().min(0).max(100),
  macroScore: z.number().min(0).max(100).optional(),
  microScore: z.number().min(0).max(100).optional(),
  geopoliticalScore: z.number().min(0).max(100).optional(),
  filterProfile: z.enum(['standard', 'strict']).optional(),
  official: z.boolean().optional(),
  org: z.string().min(1).max(60).nullable().optional(),
  expectedIntervalMs: z.number().int().positive().optional(),
  notes: z.string().nullable().optional(),
});

const sourcesFileSchema = z.object({
  version: z.number(),
  sources: z.array(sourceEntrySchema),
});

export function loadSourcesFile(path = resolve(CONFIG_DIR, 'sources.yaml')): SourcesFile {
  if (!existsSync(path)) throw new Error(`sources config not found at ${path}`);
  const parsed = sourcesFileSchema.parse(parseYaml(readFileSync(path, 'utf8')));

  const seen = new Set<string>();
  for (const s of parsed.sources) {
    if (seen.has(s.id)) throw new Error(`duplicate source id in sources.yaml: ${s.id}`);
    seen.add(s.id);
    if ((s.sourceType === 'x' || s.sourceType === 'truthsocial') && !s.handle) {
      throw new Error(`source ${s.id} is type "${s.sourceType}" but has no handle`);
    }
    if ((s.sourceType === 'rss' || s.sourceType === 'edgar') && !s.url) {
      throw new Error(`source ${s.id} is type "${s.sourceType}" but has no url`);
    }
  }
  return parsed as SourcesFile;
}

/** Config entry → the Source row shape. Scores default sensibly. */
export function toSource(entry: SourceConfigEntry, now: string): Source {
  return {
    id: entry.id,
    name: entry.name,
    handle: entry.handle ?? null,
    url: entry.url ?? null,
    sourceType: entry.sourceType,
    category: entry.category,
    priority: entry.priority,
    enabled: entry.enabled,
    verified: false,
    qualityScore: entry.qualityScore,
    noiseScore: entry.noiseScore,
    macroScore: entry.macroScore ?? 50,
    microScore: entry.microScore ?? 50,
    geopoliticalScore: entry.geopoliticalScore ?? 50,
    filterProfile: entry.filterProfile ?? 'standard',
    official: entry.official ?? false,
    org: entry.org ?? null,
    expectedIntervalMs: entry.expectedIntervalMs ?? defaultIntervalFor(entry.sourceType),
    notes: entry.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * How long a silence is normal, by source type, when the config does not say.
 * An official release feed is naturally sparse; a newswire account is not.
 */
function defaultIntervalFor(sourceType: SourceConfigEntry['sourceType']): number {
  switch (sourceType) {
    case 'x':
      return 900_000; // 15 minutes
    case 'edgar':
      return 3_600_000; // an hour
    case 'rss':
      return 86_400_000; // a day
    case 'truthsocial':
      return 900_000; // 15 minutes
    default:
      return 3_600_000;
  }
}

// ── taxonomy.yaml ────────────────────────────────────────────────────────────

const stringArray = z.array(z.string()).default([]);

const taxonomyCategorySchema = z.object({
  keywords: stringArray,
  phrases: stringArray,
  subcategories: z.record(z.string(), stringArray).default({}),
  weight: z.number().default(1),
  requires: stringArray.optional(),
});

const taxonomyFileSchema = z.object({
  version: z.number(),
  categories: z.record(z.string(), taxonomyCategorySchema),
  noise: z.object({
    opinion: stringArray,
    prediction: stringArray,
    engagementBait: stringArray,
    meme: stringArray,
    promotional: stringArray,
    personal: stringArray,
    politicalCommentary: stringArray,
    marketChatter: stringArray,
    oldNews: stringArray,
  }),
  factuality: z.object({
    factualMarkers: stringArray,
    commentaryMarkers: stringArray,
    attributionVerbs: stringArray,
  }),
  magnitude: z.object({ high: stringArray, medium: stringArray }),
  tickerStopwords: stringArray,
  commodities: z.record(z.string(), stringArray).default({}),
  countries: z.record(z.string(), stringArray).default({}),
  organizations: z.record(z.string(), stringArray).default({}),
  people: z.record(z.string(), stringArray).default({}),
});

let taxonomyCache: TaxonomyFile | null = null;

export function loadTaxonomy(path = resolve(CONFIG_DIR, 'taxonomy.yaml')): TaxonomyFile {
  if (taxonomyCache) return taxonomyCache;
  if (!existsSync(path)) throw new Error(`taxonomy config not found at ${path}`);
  const parsed = taxonomyFileSchema.parse(parseYaml(readFileSync(path, 'utf8')));

  for (const c of CATEGORIES) {
    if (!parsed.categories[c]) {
      throw new Error(`taxonomy.yaml is missing a definition for category ${c}`);
    }
  }
  taxonomyCache = parsed as TaxonomyFile;
  return taxonomyCache;
}

// ── security-master.csv (§25) ────────────────────────────────────────────────

/**
 * CSV columns: ticker,name,aliases,exchange,ambiguity,indices,sector,priority
 * `aliases` and `indices` are pipe-delimited inside the cell.
 */
let securitiesCache: Security[] | null = null;

export function loadSecurityMaster(path = resolve(CONFIG_DIR, 'security-master.csv')): Security[] {
  if (securitiesCache) return securitiesCache;
  if (!existsSync(path)) throw new Error(`security master not found at ${path}`);

  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const out: Security[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim() || line.trim().startsWith('#')) continue;
    if (i === 0 && line.toLowerCase().startsWith('ticker,')) continue;

    const cells = splitCsvLine(line);
    const [ticker, name, aliases, exchange, ambiguity, indices, sector, priority] = cells;
    if (!ticker || !name) continue;

    const amb = (ambiguity ?? 'ambiguous').trim();
    out.push({
      ticker: ticker.trim().toUpperCase(),
      name: name.trim(),
      aliases: (aliases ?? '')
        .split('|')
        .map((a) => a.trim())
        .filter(Boolean),
      exchange: (exchange ?? '').trim(),
      ambiguity: amb === 'safe' || amb === 'blocked' ? amb : 'ambiguous',
      indices: (indices ?? '')
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean),
      sector: (sector ?? '').trim() || null,
      priority: Number(priority ?? 50) || 50,
    });
  }

  securitiesCache = out;
  return out;
}

/** Minimal CSV field splitter with double-quote support. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Drop caches so the next load re-reads from disk. */
export function reloadConfig(): void {
  taxonomyCache = null;
  securitiesCache = null;
}

// ── Discord intelligence sources ─────────────────────────────────────────────

const discordAuthorSchema = z.object({
  name: z.string().min(1).max(120),
  qualityScore: z.number().min(0).max(100).nullable().optional(),
});

const discordChannelSchema = z.object({
  id: z.string().min(1).max(40),
  sourceId: z.string().min(1).max(120),
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  /**
   * Scout's own bot reads this channel over the gateway, with ordinary bot
   * permissions on a server the operator controls. Default false: a channel is
   * delivered by an authorized bridge unless it is explicitly an intake channel.
   */
  intake: z.boolean().optional(),
  qualityScore: z.number().min(0).max(100).optional(),
  noiseScore: z.number().min(0).max(100).optional(),
  filterProfile: z.enum(['standard', 'strict']).optional(),
  authors: z.array(discordAuthorSchema).optional(),
});

const discordDestinationsSchema = z.object({
  general: z.string().min(1).max(40).optional(),
  spx_macro: z.string().min(1).max(40).optional(),
  tickers: z.string().min(1).max(40).optional(),
});

const discordSourcesFileSchema = z.object({
  version: z.number(),
  channels: z.array(discordChannelSchema),
  destinations: discordDestinationsSchema.optional(),
});

/**
 * The Discord intelligence allowlist. Absent or empty is a valid configuration
 * — it simply means the Discord source is not in use — so this never throws for
 * a missing file. A malformed one DOES throw: silently ingesting from an
 * unintended channel is worse than failing to boot.
 */
export function loadDiscordSources(
  path = resolve(CONFIG_DIR, 'discord-sources.yaml'),
): DiscordSourcesFile {
  if (!existsSync(path)) return { version: 1, channels: [], destinations: {} };

  const parsed = discordSourcesFileSchema.parse(parseYaml(readFileSync(path, 'utf8')));

  const seenChannel = new Set<string>();
  const seenSourceId = new Set<string>();

  const channels: DiscordChannelConfig[] = parsed.channels.map((c) => {
    const id = c.id.trim();
    if (seenChannel.has(id)) {
      throw new Error(`duplicate Discord channel id in discord-sources.yaml: ${id}`);
    }
    seenChannel.add(id);

    if (seenSourceId.has(c.sourceId)) {
      throw new Error(`duplicate Discord sourceId in discord-sources.yaml: ${c.sourceId}`);
    }
    seenSourceId.add(c.sourceId);

    // The prefix is what tells provenance, dedupe reporting and the source
    // report that this event came from Discord rather than X.
    if (!c.sourceId.startsWith('discord:')) {
      throw new Error(
        `Discord sourceId must start with "discord:" so provenance is unambiguous — got "${c.sourceId}"`,
      );
    }

    return {
      id,
      sourceId: c.sourceId,
      name: c.name ?? c.sourceId,
      enabled: c.enabled ?? true,
      intake: c.intake ?? false,
      qualityScore: c.qualityScore ?? 70,
      noiseScore: c.noiseScore ?? 30,
      filterProfile: c.filterProfile ?? 'standard',
      authors: (c.authors ?? []).map((a) => ({
        name: a.name,
        qualityScore: a.qualityScore ?? null,
      })),
    };
  });

  const d = parsed.destinations ?? {};
  const destinations: DiscordDestinations = {
    ...(d.general ? { general: d.general.trim() } : {}),
    ...(d.spx_macro ? { spxMacro: d.spx_macro.trim() } : {}),
    ...(d.tickers ? { tickers: d.tickers.trim() } : {}),
  };

  // A channel cannot be both a source and a destination.
  //
  // Scout would publish an alert into it, read that alert back as intelligence,
  // and re-publish — a loop that looks like a busy news day from the outside.
  // The self-message guard in the listener stops the exact-same-bot case, but
  // relying on it means one refactor away from a feedback loop in production.
  // Configuration is where this belongs: the two roles are disjoint by
  // construction, and a mistake fails at boot rather than at 09:31.
  const destinationIds = new Map<string, string>([
    ...(destinations.general ? ([[destinations.general, 'destinations.general']] as const) : []),
    ...(destinations.spxMacro ? ([[destinations.spxMacro, 'destinations.spx_macro']] as const) : []),
    ...(destinations.tickers ? ([[destinations.tickers, 'destinations.tickers']] as const) : []),
  ]);

  for (const channel of channels) {
    const role = destinationIds.get(channel.id);
    if (!role) continue;
    throw new Error(
      `Discord channel ${channel.id} is configured both as a source (${channel.sourceId}) and as ` +
        `${role} in discord-sources.yaml. Scout would publish there and then read its own alerts ` +
        'back in as intelligence. Give the intake channel and the output channel different ids.',
    );
  }

  return { version: parsed.version, channels, destinations };
}

/** Config entry → the Source row shape, so Discord channels score like anything else. */
export function toDiscordSource(channel: DiscordChannelConfig, now: string): Source {
  return {
    id: channel.sourceId,
    name: channel.name,
    handle: null,
    url: null,
    // Pushed, not polled — the same category the Discord URL relay uses. Scout
    // never fetches these; an authorized bridge delivers them.
    sourceType: 'manual',
    category: 'MARKET',
    priority: Math.round(channel.qualityScore),
    enabled: channel.enabled,
    verified: true,
    qualityScore: channel.qualityScore,
    noiseScore: channel.noiseScore,
    macroScore: 50,
    microScore: 60,
    geopoliticalScore: 40,
    filterProfile: channel.filterProfile,
    official: false,
    // Each Discord channel is its own organisation for corroboration purposes:
    // two bots in one channel repeating each other are not two confirmations.
    org: channel.sourceId,
    expectedIntervalMs: 900_000,
    notes: `Discord intelligence source, channel ${channel.id}`,
    createdAt: now,
    updatedAt: now,
  };
}
