import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CATEGORIES } from '../core/types.js';
import type { Security, Source } from '../core/types.js';
import type { SourceConfigEntry, SourcesFile, TaxonomyFile } from './types.js';

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
  sourceType: z.enum(['x', 'rss', 'edgar', 'manual']),
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
    if (s.sourceType === 'x' && !s.handle) {
      throw new Error(`source ${s.id} is type "x" but has no handle`);
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
