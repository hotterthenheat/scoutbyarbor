import { describe, it, expect } from 'vitest';
import {
  createTruthSocialAdapter,
  acctOf,
  canonicalTruthId,
} from '../src/ingest/adapters/truthSocial.js';
import { canonicalIdFromWebhook } from '../src/server/webhook.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { loadSourcesFile, toSource } from '../src/config/loader.js';
import type { Source } from '../src/core/types.js';

/**
 * Truth Social over the public Mastodon-compatible API.
 *
 * No credential, no key, and nothing that circumvents an access control — the
 * account and status endpoints answer anonymous reads, and if they ever stop,
 * the right outcome is that this adapter stops working.
 *
 * The property that matters most is the ID SCHEME. A post read here and the
 * same post pushed by a relay must collapse into one event, and dedupe is by
 * canonical id, so both paths have to produce the same string.
 */

setLogLevel('silent');
const log = createLogger('truth-test');

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

/** The account payload, exactly as the live endpoint returns it. */
const ACCOUNT = {
  id: '107780257626128497',
  username: 'realDonaldTrump',
  display_name: 'Donald J. Trump',
  verified: true,
};

function status(over: Record<string, unknown> = {}) {
  return {
    id: '113900000000000001',
    created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    content: '<p>WE WILL IMPOSE MAJOR NEW TARIFFS ON CHINESE IMPORTS EFFECTIVE SEPTEMBER 1!</p>',
    url: 'https://truthsocial.com/@realDonaldTrump/113900000000000001',
    in_reply_to_id: null,
    reblog: null,
    ...over,
  };
}

function adapterServing(statuses: unknown, account: unknown = ACCOUNT) {
  const calls: string[] = [];
  const adapter = createTruthSocialAdapter({
    userAgent: 'Scout test',
    timeoutMs: 5_000,
    logger: log,
    fetchImpl: (async (url: string) => {
      const u = String(url);
      calls.push(u);
      const body = u.includes('/lookup') ? account : statuses;
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch,
  });
  return { adapter, calls };
}

describe('reading an account', () => {
  it('looks the handle up, then fetches its statuses', async () => {
    const { adapter, calls } = adapterServing([status()]);
    const result = await adapter.poll([SOURCE]);

    expect(calls[0]).toContain('/api/v1/accounts/lookup?acct=realDonaldTrump');
    expect(calls[1]).toContain(`/api/v1/accounts/${ACCOUNT.id}/statuses`);
    expect(result.posts).toHaveLength(1);
    expect(result.outcomes[0]?.ok).toBe(true);
  });

  it('resolves the account once, not once per poll', async () => {
    const { adapter, calls } = adapterServing([status()]);
    await adapter.poll([SOURCE]);
    await adapter.poll([SOURCE]);

    expect(calls.filter((c) => c.includes('/lookup'))).toHaveLength(1);
  });

  it('strips the HTML the API returns', async () => {
    const { adapter } = adapterServing([status()]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.text).toBe('WE WILL IMPOSE MAJOR NEW TARIFFS ON CHINESE IMPORTS EFFECTIVE SEPTEMBER 1!');
    expect(post.text).not.toContain('<p>');
  });

  it("reads the post's own timestamp as publication time", async () => {
    const when = new Date(Date.now() - 6 * 60_000).toISOString();
    const { adapter } = adapterServing([status({ created_at: when })]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.meta.publishedAt).toBe(when);
    expect(post.meta.publishedAtKnown).toBe(true);
  });

  it('attributes the post to the handle', async () => {
    const { adapter } = adapterServing([status()]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;
    expect(post.author).toBe('@realDonaldTrump');
    expect(post.originalUrl).toContain('truthsocial.com/@realDonaldTrump/');
  });
});

/**
 * The same post can arrive twice: read here, and pushed by somebody's relay.
 * Dedupe is by canonical id, so the two paths must agree on the string or the
 * event publishes twice.
 */
describe('the id scheme', () => {
  it('matches what the webhook path derives for the same post', () => {
    expect(canonicalTruthId('113900000000000001')).toBe(
      canonicalIdFromWebhook('113900000000000001', 'truthsocial'),
    );
    expect(canonicalTruthId('113900000000000001')).toBe('truth:113900000000000001');
  });

  it('normalises a handle with or without the @', () => {
    expect(acctOf('@realDonaldTrump')).toBe('realDonaldTrump');
    expect(acctOf('realDonaldTrump')).toBe('realDonaldTrump');
  });
});

describe('what it declines to ingest', () => {
  it('skips replies, which are conversation rather than statement', async () => {
    const { adapter } = adapterServing([status({ in_reply_to_id: '999' })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(0);
  });

  it('skips reblogs, which would be attributed to the wrong account', async () => {
    const { adapter } = adapterServing([status({ reblog: { id: '5' } })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(0);
  });

  it('skips a post with no text left after stripping', async () => {
    const { adapter } = adapterServing([status({ content: '<p></p>' })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(0);
  });

  it('does not re-emit a post it has already seen', async () => {
    const { adapter } = adapterServing([status(), status({ id: '2', content: '<p>SECOND</p>' })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(2);
    expect((await adapter.poll([SOURCE])).posts, 'the page was re-emitted').toHaveLength(0);
  });

  it('drops posts older than the cold-start window', async () => {
    const old = new Date(Date.now() - 8 * 3600_000).toISOString();
    const { adapter } = adapterServing([status({ created_at: old })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(0);
  });
});

describe('failures', () => {
  function failingAdapter(httpStatus: number) {
    return createTruthSocialAdapter({
      userAgent: 'Scout test',
      timeoutMs: 5_000,
      logger: log,
      fetchImpl: (async () =>
        ({ ok: false, status: httpStatus, json: async () => ({}) }) as Response) as unknown as typeof fetch,
    });
  }

  it('says plainly that it will not work around bot protection', async () => {
    const result = await failingAdapter(403).poll([SOURCE]);
    expect(result.outcomes[0]?.ok).toBe(false);
    // The whole point: a challenge means this source stops, not that Scout
    // starts pretending to be a browser.
    expect(result.outcomes[0]?.error).toMatch(/does not circumvent bot protection/i);
  });

  it('names a rate limit as a rate limit', async () => {
    expect((await failingAdapter(429).poll([SOURCE])).outcomes[0]?.error).toMatch(/rate limited/i);
  });

  it('does not throw out of poll when the account is gone', async () => {
    const result = await failingAdapter(404).poll([SOURCE]);
    expect(result.outcomes[0]?.ok).toBe(false);
    expect(result.posts).toHaveLength(0);
  });
});

describe('the shipped configuration', () => {
  it('registers the account with a handle, as the loader requires', () => {
    const entry = loadSourcesFile().sources.find((s) => s.id === 'truth:realdonaldtrump');
    expect(entry?.sourceType).toBe('truthsocial');
    expect(entry?.handle).toBe('@realDonaldTrump');
    expect(entry?.enabled).toBe(true);
  });
});

/**
 * Two cable-news accounts on the same platform.
 *
 * They are high volume and mostly politics, so the question is not whether
 * they carry market news — sometimes they do — but whether the rest floods the
 * wire. The category gate needs market evidence AND a market entity, the noise
 * filters run after it, and the strict profile requires reported fact.
 */
describe('the cable-news accounts', () => {
  it('gives each its own org, so the two corroborate as two outlets', () => {
    const byId = new Map(loadSourcesFile().sources.map((s) => [s.id, s]));

    expect(byId.get('truth:foxnews')?.org).toBe('foxnews');
    expect(byId.get('truth:newsmax')?.org).toBe('newsmax');
    // And neither shares an org with the account whose statements they report,
    // or a Trump post plus its coverage would look like one body twice.
    expect(byId.get('truth:realdonaldtrump')?.org).toBe('trump');
  });

  /**
   * Both ship DISABLED, and that is a cost decision rather than an editorial
   * one. The vendor transport bills per post returned, so every enabled account
   * multiplies the hourly spend — three accounts is three times the burn rate
   * for the same balance. Only the account the wire exists for is left on.
   */
  it('ships disabled, so they cost nothing until the balance supports them', () => {
    const byId = new Map(loadSourcesFile().sources.map((s) => [s.id, s]));

    expect(byId.get('truth:foxnews')?.enabled).toBe(false);
    expect(byId.get('truth:newsmax')?.enabled).toBe(false);
    expect(byId.get('truth:realdonaldtrump')?.enabled, 'the primary account was left off').toBe(
      true,
    );
  });

  it('scores them as secondary reporting, not first-hand statement', () => {
    const byId = new Map(loadSourcesFile().sources.map((s) => [s.id, s]));
    const trump = byId.get('truth:realdonaldtrump')!;

    for (const id of ['truth:foxnews', 'truth:newsmax']) {
      const outlet = byId.get(id)!;
      expect(outlet.qualityScore, `${id} outranks the primary source`).toBeLessThan(
        trump.qualityScore,
      );
      expect(outlet.noiseScore, `${id} is not scored as noisy`).toBeGreaterThan(trump.noiseScore);
      expect(outlet.filterProfile, `${id} is not on the strict gate`).toBe('strict');
    }
  });
});
