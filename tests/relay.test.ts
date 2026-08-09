import { describe, it, expect } from 'vitest';
import { parseRelayContent, hasUsableContent } from '../src/ingest/relayParser.js';
import { parsePostUrl, detectPostUrls } from '../src/ingest/urls.js';

/** The relay parser is the primary ingestion path, so it gets pinned hard. */

const url = parsePostUrl('https://x.com/DeItaone/status/2058552301120360937')!;

describe('attribution', () => {
  it('parses the spec’s worked format', () => {
    const parsed = parseRelayContent(
      `Macro Alert (@DeItaone):\n\nNO NUCLEAR IRAN\n\nTrump called the deal one of the worst ever.\n\nhttps://x.com/DeItaone/status/2058552301120360937`,
      url,
    );
    expect(parsed.author).toBe('Macro Alert');
    expect(parsed.authorHandle).toBe('@DeItaone');
    expect(parsed.text).toContain('NO NUCLEAR IRAN');
    expect(parsed.text).toContain('one of the worst ever');
    // The relay's framing is not part of the story.
    expect(parsed.text).not.toContain('Macro Alert');
    expect(parsed.text).not.toContain('@DeItaone');
  });

  it.each([
    ['@DeItaone:\n\nFED CUTS RATES BY 25 BPS', '@DeItaone'],
    ['Walter Bloomberg (@DeItaone):\n\nFED CUTS RATES BY 25 BPS', '@DeItaone'],
    ['**Breaking** (@DeItaone) — FED CUTS RATES BY 25 BPS', '@DeItaone'],
  ])('handles the shape %s', (raw, handle) => {
    const parsed = parseRelayContent(raw, url);
    expect(parsed.authorHandle).toBe(handle);
    expect(parsed.text).toContain('FED CUTS RATES');
  });

  it('falls back to the URL handle when the relay names none', () => {
    const parsed = parseRelayContent('FED CUTS RATES BY 25 BPS', url);
    expect(parsed.authorHandle).toBe('@DeItaone');
    expect(parsed.signals).toContain('relay:handle-from-url');
  });

  it('does not treat a mention inside the story as a byline', () => {
    const parsed = parseRelayContent(
      'FED CUTS RATES BY 25 BPS\n\nThe decision was first reported by @markets earlier today and confirmed since.',
      url,
    );
    expect(parsed.authorHandle).toBe('@DeItaone');
    expect(parsed.text).toContain('@markets');
  });
});

describe('publication time', () => {
  it('is null when the relay states none', () => {
    const parsed = parseRelayContent('Macro Alert (@DeItaone):\n\nNO NUCLEAR IRAN', url);
    // The relay's own message time is when Scout heard about the post, not
    // when it was published. Substituting it lets an old headline look fresh.
    expect(parsed.publishedAt).toBeNull();
  });

  it('is used when the relay states one', () => {
    const parsed = parseRelayContent(
      'Macro Alert (@DeItaone):\n\nNO NUCLEAR IRAN\n\n2026-05-24T21:14:00Z',
      url,
    );
    expect(parsed.publishedAt).toBe('2026-05-24T21:14:00.000Z');
  });

  it('ignores a stated time in the future', () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(parseRelayContent(`HEADLINE HERE\n\n${future}`, url).publishedAt).toBeNull();
  });
});

describe('usable content', () => {
  it('rejects a bare link', () => {
    expect(hasUsableContent(parseRelayContent('', url))).toBe(false);
    expect(hasUsableContent(parseRelayContent('   ', url))).toBe(false);
  });

  it('rejects an attribution with no story', () => {
    expect(hasUsableContent(parseRelayContent('Macro Alert (@DeItaone):', url))).toBe(false);
  });

  it('accepts a real headline', () => {
    expect(hasUsableContent(parseRelayContent('FED CUTS RATES BY 25 BPS', url))).toBe(true);
  });
});

describe('Truth Social runs the same path', () => {
  it('normalises a Truth Social URL', () => {
    const parsed = parsePostUrl('https://truthsocial.com/@realDonaldTrump/posts/113456789012345678');
    expect(parsed).toMatchObject({
      platform: 'truthsocial',
      username: 'realDonaldTrump',
      postId: '113456789012345678',
      canonicalId: 'truth:113456789012345678',
    });
  });

  it('keeps X and Truth Social ids distinct', () => {
    const found = detectPostUrls(
      'https://x.com/a/status/12345 and https://truthsocial.com/@a/posts/12345',
    );
    expect(found.map((f) => f.canonicalId)).toEqual(['x:12345', 'truth:12345']);
  });

  it('parses a Truth Social relay identically', () => {
    const tsUrl = parsePostUrl('https://truthsocial.com/@realDonaldTrump/posts/113456789012345678')!;
    const parsed = parseRelayContent(
      'Truth Social (@realDonaldTrump):\n\nWE WILL IMPOSE MAJOR NEW SANCTIONS ON RUSSIA',
      tsUrl,
    );
    expect(parsed.authorHandle).toBe('@realDonaldTrump');
    expect(parsed.text).toContain('SANCTIONS ON RUSSIA');
  });
});
