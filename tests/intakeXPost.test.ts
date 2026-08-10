import { describe, it, expect } from 'vitest';
import { flattenMessage } from '../src/ingest/discordIntel/normalize.js';
import { parseRelay } from '../src/ingest/discordIntel/relay.js';
import { detectPostUrls } from '../src/ingest/urls.js';
import { parseRelayContent } from '../src/ingest/relayParser.js';
import type { DiscordMessageEnvelope } from '../src/ingest/discordIntel/types.js';

/**
 * An X post pasted into the intake channel.
 *
 * This is the free X route, and the only one that works with no API key: paste
 * or forward the post into a channel Scout can read, and Scout reads the text
 * Discord expanded alongside the link. No credential, no polling, no relay
 * process.
 *
 * The property that matters is IDENTITY. Such a post must become `x:<postId>`,
 * not `discord:<messageId>` — otherwise the same post arriving later through a
 * webhook is a second event rather than the same one, and provenance names the
 * channel it passed through instead of the account that wrote it.
 */

function envelope(content: string, embeds: DiscordMessageEnvelope['embeds'] = []) {
  return {
    messageId: 'm-1',
    channelId: '1081082844807434292',
    channelName: 'intel',
    guildId: '111',
    authorId: '900',
    authorName: 'zak',
    isBot: false,
    content,
    embeds,
    attachments: [],
    timestamp: '2026-08-10T14:00:00.000Z',
    editedTimestamp: null,
    receivedAt: '2026-08-10T14:00:01.000Z',
  } satisfies DiscordMessageEnvelope;
}

const POST_URL = 'https://x.com/DeItaone/status/2058552301120360937';

describe('an X link pasted into the intake channel', () => {
  it('is detected as a post URL and keeps the X identity', () => {
    const text = flattenMessage(envelope(POST_URL));
    const urls = detectPostUrls(text);

    expect(urls, 'a pasted X link was not detected').toHaveLength(1);
    // `x:<postId>` — the SAME key the webhook path derives, so one post seen
    // twice by two routes collapses into one event.
    expect(urls[0]?.canonicalId).toBe('x:2058552301120360937');
    expect(urls[0]?.platform).toBe('x');
    expect(urls[0]?.username?.toLowerCase()).toBe('deitaone');
  });

  it('reads the post text out of the embed Discord expanded', () => {
    // What Discord attaches when it can still expand an X link: the account on
    // the embed author, the post body in the description, the ORIGINAL time.
    const message = envelope(POST_URL, [
      {
        title: null,
        description: 'FED CUTS RATES BY 50 BPS',
        url: POST_URL,
        timestamp: '2026-08-10T13:58:00.000Z',
        author: 'Walter Bloomberg (@DeItaone)',
        footer: 'X',
        fields: [],
      },
    ]);

    const text = flattenMessage(message);
    const urls = detectPostUrls(text);
    expect(urls).toHaveLength(1);

    // The relay resolver reads exactly this, with no credential.
    const parsed = parseRelayContent(text, urls[0]!);
    expect(parsed.text).toContain('FED CUTS RATES BY 50 BPS');
  });

  it('still recovers the account when Discord strips the embed', () => {
    // X has been restricting embed expansion, so a bare link is a real case.
    // The URL itself still names the account, which is all the relay path needs
    // to attribute it; the text is what may be missing.
    const urls = detectPostUrls(flattenMessage(envelope(`look at this ${POST_URL}`)));
    expect(urls[0]?.username?.toLowerCase()).toBe('deitaone');
    expect(urls[0]?.canonicalId).toBe('x:2058552301120360937');
  });

  it('leaves a message with no post link on the Discord path', () => {
    // Not everything in the intake channel is an X post, and a plain message
    // must still be ingestible as Discord intelligence.
    const text = flattenMessage(envelope('BREAKING: ECB cuts by 25bps'));
    expect(detectPostUrls(text)).toHaveLength(0);
  });

  it('finds the link inside a forwarded message, not just a pasted one', () => {
    const parsed = parseRelay({
      content: '',
      embeds: [],
      attachments: [],
      carrier: { id: '900', name: 'zak', isBot: false, isWebhook: false },
      relayedAt: '2026-08-10T14:00:00.000Z',
      forward: {
        content: `FED CUTS RATES BY 50 BPS ${POST_URL}`,
        embeds: [],
        attachments: [],
        timestamp: '2026-08-10T13:58:00.000Z',
        editedTimestamp: null,
        channelId: '555',
        guildId: '444',
        messageId: '666',
      },
    });

    // The forwarded payload becomes the message content, so URL detection sees
    // it exactly as it would a paste.
    expect(detectPostUrls(parsed.content)[0]?.canonicalId).toBe('x:2058552301120360937');
  });
});
