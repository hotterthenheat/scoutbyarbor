import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTruthSocialAdapter,
  canonicalTruthId,
  statusesFromVendor,
} from '../src/ingest/adapters/truthSocial.js';
import { createCreditBudget, utcDayOf } from '../src/ingest/adapters/creditBudget.js';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { toSource } from '../src/config/loader.js';
import type { Source } from '../src/core/types.js';

/**
 * Truth Social over the vendor transport.
 *
 * The public endpoints refuse datacenter IPs, so on the deployed instance every
 * Truth Social source sat DISCONNECTED. Reading the same posts from a paid API
 * fixes that, and introduces a constraint the free route never had: the vendor
 * bills PER POST RETURNED. Polling is then a standing order to spend money, and
 * the tests that matter most here are the ones about not spending it.
 */

setLogLevel('silent');
const log = createLogger('vendor-test');

const SOURCE: Source = toSource(
  {
    id: 'truth:realdonaldtrump',
    name: 'Donald J. Trump — Truth Social',
    handle: '@realDonaldTrump',
    url: 'https://truthsocial.com',
    sourceType: 'truthsocial',
    category: 'GEOPOLITICAL',
    priority: 92,
    enabled: true,
    qualityScore: 88,
    noiseScore: 45,
  },
  new Date().toISOString(),
);

function status(over: Record<string, unknown> = {}) {
  return {
    id: '113900000000000001',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    content: '<p>WE WILL IMPOSE MAJOR NEW TARIFFS ON CHINESE IMPORTS!</p>',
    url: 'https://truthsocial.com/@realDonaldTrump/113900000000000001',
    in_reply_to_id: null,
    reblog: null,
    ...over,
  };
}

let dir: string;
let db: ScoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-vendor-'));
  db = openDatabase(join(dir, 'test.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

function vendorAdapter(
  body: unknown,
  over: { pageLimit?: number; budgetLimit?: number; httpStatus?: number } = {},
) {
  const calls: Call[] = [];
  const budget =
    over.budgetLimit === undefined
      ? undefined
      : createCreditBudget({ db, vendor: 'scrapecreators', limit: over.budgetLimit });

  const adapter = createTruthSocialAdapter({
    userAgent: 'Scout test',
    timeoutMs: 5_000,
    logger: log,
    vendor: {
      apiKey: 'test-key',
      baseUrl: 'https://api.scrapecreators.com',
      ...(over.pageLimit === undefined ? {} : { pageLimit: over.pageLimit }),
      ...(budget ? { budget } : {}),
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
      return {
        ok: (over.httpStatus ?? 200) < 400,
        status: over.httpStatus ?? 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch,
  });

  return { adapter, calls, budget };
}

describe('choosing a transport', () => {
  it('reads the vendor, not Truth Social, once a key is set', async () => {
    const { adapter, calls } = vendorAdapter([status()]);
    await adapter.poll([SOURCE]);

    expect(calls[0]?.url).toContain('api.scrapecreators.com/v1/truthsocial/user/posts');
    expect(calls[0]?.url).toContain('handle=realDonaldTrump');
    // And never the public endpoint, which is what was returning 403.
    expect(calls.some((c) => c.url.includes('truthsocial.com/api/v1'))).toBe(false);
  });

  it('authenticates with the header the vendor documents', async () => {
    const { adapter, calls } = vendorAdapter([status()]);
    await adapter.poll([SOURCE]);
    expect(calls[0]?.headers['x-api-key']).toBe('test-key');
  });

  it('falls back to reading Truth Social directly with no key', async () => {
    const calls: string[] = [];
    const adapter = createTruthSocialAdapter({
      userAgent: 'Scout test',
      timeoutMs: 5_000,
      logger: log,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        const body = String(url).includes('/lookup') ? { id: '1' } : [status()];
        return { ok: true, status: 200, json: async () => body } as Response;
      }) as unknown as typeof fetch,
    });
    await adapter.poll([SOURCE]);

    expect(calls[0]).toContain('truthsocial.com/api/v1/accounts/lookup');
    expect(calls.some((c) => c.includes('scrapecreators'))).toBe(false);
  });
});

/**
 * The reason both transports can coexist. A post read directly, read through
 * the vendor, or pushed by a relay must be ONE event — otherwise switching
 * transports republishes the wire's recent history.
 */
describe('the id scheme survives the transport', () => {
  it('produces the same canonical id the direct route does', async () => {
    const { adapter } = vendorAdapter([status()]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.sourcePostId).toBe(canonicalTruthId('113900000000000001'));
    expect(post.sourcePostId).toBe('truth:113900000000000001');
  });

  it('keeps the byline on the account, naming the vendor only as retrieval', async () => {
    const { adapter } = vendorAdapter([status()]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.author).toBe('@realDonaldTrump');
    expect(post.meta.retrievalSource).toBe('scrapecreators-api');
    expect(post.meta.provenance).toBe('truth_social');
  });

  it("reads the post's own timestamp, not the moment it was fetched", async () => {
    const when = new Date(Date.now() - 90_000).toISOString();
    const { adapter } = vendorAdapter([status({ created_at: when })]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.meta.publishedAt).toBe(when);
    expect(post.meta.publishedAtKnown).toBe(true);
  });
});

/**
 * The vendor's exact envelope could not be verified from the build environment,
 * so the parser accepts the usual shapes and the adapter reports what it got
 * when none match. A wrong guess has to surface as a named fault within one
 * poll, not as a feed that is quietly always empty.
 */
describe('reading the vendor payload', () => {
  it.each([
    ['a bare array', (s: unknown) => [s]],
    ['a posts envelope', (s: unknown) => ({ posts: [s] })],
    ['a data envelope', (s: unknown) => ({ data: [s] })],
    ['a statuses envelope', (s: unknown) => ({ statuses: [s] })],
  ])('handles %s', async (_label, wrap) => {
    const { adapter } = vendorAdapter(wrap(status()));
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(1);
  });

  it('locates nothing in an unrecognised shape rather than inventing posts', () => {
    expect(statusesFromVendor({ unexpected: 'shape' })).toBeNull();
  });

  it('names the keys it actually received, so the fix is obvious', async () => {
    const { adapter } = vendorAdapter({ unexpected: 'shape', other: 1 });
    const outcome = (await adapter.poll([SOURCE])).outcomes[0]!;

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unrecognised payload/);
    expect(outcome.error).toMatch(/unexpected/);
  });
});

describe('vendor failures say what to do about them', () => {
  it.each([
    [401, /API key was rejected/i],
    [402, /out of credits/i],
  ])('explains HTTP %i', async (httpStatus, expected) => {
    const { adapter } = vendorAdapter([], { httpStatus });
    expect((await adapter.poll([SOURCE])).outcomes[0]?.error).toMatch(expected);
  });

  it('does not blame bot protection when the vendor is the one refusing', async () => {
    const { adapter } = vendorAdapter([], { httpStatus: 403 });
    const error = (await adapter.poll([SOURCE])).outcomes[0]?.error ?? '';

    expect(error).toMatch(/vendor refused/i);
    expect(error, 'the direct-transport wording leaked').not.toMatch(/circumvent/i);
  });
});

/**
 * The money.
 *
 * Billing is per post returned, so a page of twenty costs twenty credits every
 * single poll — including the nineteen already published. On a hundred-credit
 * balance the page size, not the poll interval, is the dominant cost.
 */
describe('spending credits', () => {
  it('asks for a small page, because the page is the price', async () => {
    const { adapter, calls } = vendorAdapter([status()], { pageLimit: 3 });
    await adapter.poll([SOURCE]);
    expect(calls[0]?.url).toContain('limit=3');
  });

  it('charges for posts returned, not for the request', async () => {
    const { adapter, budget } = vendorAdapter([status(), status({ id: '2' })], {
      pageLimit: 5,
      budgetLimit: 100,
    });
    await adapter.poll([SOURCE]);

    // Reserved 5 (the page), settled to the 2 that actually came back.
    expect(budget!.spent()).toBe(2);
  });

  it('stops polling once the daily budget is gone', async () => {
    const { adapter, budget } = vendorAdapter([status()], { pageLimit: 3, budgetLimit: 3 });

    const first = await adapter.poll([SOURCE]);
    expect(first.outcomes[0]?.ok).toBe(true);

    // The first poll settled to 1, leaving 2 — not enough to reserve a page of 3.
    const second = await adapter.poll([SOURCE]);
    expect(second.outcomes[0]?.ok).toBe(false);
    expect(second.outcomes[0]?.error).toMatch(/credit budget spent/i);
    expect(budget!.remaining()).toBe(2);
  });

  it('makes no request at all once the budget is spent', async () => {
    const { adapter, calls } = vendorAdapter([status()], { pageLimit: 3, budgetLimit: 1 });
    await adapter.poll([SOURCE]);

    expect(calls, 'a request was sent despite an exhausted budget').toHaveLength(0);
  });
});

/**
 * The counter is persisted because Scout restarts on every deploy. An
 * in-process counter would let a redeploy loop spend an entire balance while
 * reporting that it had barely started.
 */
describe('the credit counter', () => {
  it('survives a restart', () => {
    const first = createCreditBudget({ db, vendor: 'scrapecreators', limit: 100 });
    first.tryReserve(20);
    expect(first.spent()).toBe(20);

    // A new instance over the same database is what a redeploy looks like.
    const afterRestart = createCreditBudget({ db, vendor: 'scrapecreators', limit: 100 });
    expect(afterRestart.spent()).toBe(20);
    expect(afterRestart.remaining()).toBe(80);
  });

  it('refuses a reservation that would exceed the cap', () => {
    const budget = createCreditBudget({ db, vendor: 'scrapecreators', limit: 10 });

    expect(budget.tryReserve(8)).toBe(true);
    expect(budget.tryReserve(8), 'the cap was allowed to overshoot').toBe(false);
    expect(budget.spent()).toBe(8);
  });

  it('resets when the UTC day rolls over', () => {
    let today = new Date('2026-08-10T23:59:00Z');
    const budget = createCreditBudget({
      db,
      vendor: 'scrapecreators',
      limit: 10,
      now: () => today,
    });

    budget.tryReserve(10);
    expect(budget.remaining()).toBe(0);

    today = new Date('2026-08-11T00:01:00Z');
    expect(budget.remaining()).toBe(10);
  });

  it('keeps two vendors on separate meters', () => {
    const a = createCreditBudget({ db, vendor: 'scrapecreators', limit: 10 });
    const b = createCreditBudget({ db, vendor: 'someone-else', limit: 10 });

    a.tryReserve(5);
    expect(b.spent()).toBe(0);
  });

  it('buckets by UTC day', () => {
    expect(utcDayOf(new Date('2026-08-10T17:04:00Z'))).toBe('2026-08-10');
  });
});
