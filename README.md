# Scout — Arbor Capital

A private newswire for Discord. Scout ingests a curated set of sources, throws away
the noise, collapses the same story reported five ways into one event, and posts
what is left in a deliberately austere format.

It is not a feed mirror, an aggregator, a chatbot, or a signal generator. The
product is the filtering.

```
X URLs relayed into Discord ─┐
X timelines / RSS / EDGAR ───┴─→ INGEST → NORMALIZE → DEDUPE → CLASSIFY → FILTER
                                                                            ↓
                                    DISCORD ← ROUTE ← FORMAT ← RANK ← CLUSTER
```

Scout runs continuously — premarket, overnight, weekends, holidays. There is no
market-hours gate anywhere in the pipeline, because policy and geopolitical news
does not wait for the open.

---

## The alert

This is the entire user-facing surface:

```
MACRO ALERT

NO NUCLEAR IRAN

5:14 PM · May 24, 2026

Trump called the Obama-era Iran nuclear deal "one of the worst deals ever,"
saying it gave Iran a path to nuclear weapons...
```

No author, no handle, no source name, no URL, no engagement counts, no sentiment,
no confidence percentage, no AI summary, no buttons.

That constraint is enforced by the type system, not by convention. The renderer
accepts a `RenderableAlert`, which has exactly four fields — `banner`, `headline`,
`timestamp`, `body` — and structurally cannot carry the rest. The publisher then
runs `assertNoLeakedMetadata()` over the rendered string against the post's real
handle and URL as a second line of defence. Adding a source label to an alert
would require changing the type first, which is the point.

All the hidden fields live in the database and in `#scout-raw`.

---

## Quick start

```bash
npm install
cp .env.example .env          # fill in DISCORD_BOT_TOKEN + DISCORD_GUILD_ID

npm run db:migrate            # create the schema
npm run sources:sync          # load config/sources.yaml into the database
npm run sources:verify        # confirm every handle and feed URL actually resolves
npm run discord:setup         # create the channels, print their ids for .env

npm run dev                   # or: npm run build && npm start
```

**Scout needs no X API key.** The primary path reads the content a permitted
relay already posted alongside the link, so a relayed post is resolved with no
credential and no second request. On boot you will see:

```
X API: NOT CONFIGURED — URL/RELAY INGESTION: ENABLED
```

That is a normal configuration, not a fault. `X_BEARER_TOKEN` is optional and
adds exactly two things: a fallback for links relayed *without* their text, and
polling of the X accounts in `config/sources.yaml`. The RSS and EDGAR layers —
the Fed, BLS, BEA, Treasury, the SEC and the central banks — never needed a
credential either.

Try the classifier before pointing it at anything live:

```bash
npm run scout classify "FED'S POWELL: FURTHER RATE CUTS WILL DEPEND ON INFLATION PROGRESS"
npm run scout classify "NVDA is looking strong today"
```

The first renders a `FED ALERT`. The second is rejected as `NOISE_MARKET_CHATTER`.

---

## How a post becomes an alert

| Stage | What happens | Spec |
|---|---|---|
| **Normalize** | Strip URLs, handles, RT prefixes, hashtag clouds. Split headline from body. Compute a fingerprint and a 64-bit simhash. | §35 |
| **Deduplicate** | Five layers: post id → canonicalised URL → fingerprint → text similarity → shared entities inside a time window. | §17 |
| **Classify** | Ten categories, keyword + phrase + entity evidence, with precedence rules (an actual release is `ECONOMIC`, not `MACRO`; a Powell post is `FED`). | §4 |
| **Extract** | Tickers via a security master with per-symbol ambiguity levels; countries, organisations, people, commodities, and numeric figures. | §25 |
| **Filter** | Ten noise classes, plus a factuality gate that separates reporting from commentary on the accounts that mix them. | §20, §8 |
| **Cluster** | Related developments join one event. A bigger development supersedes the previous alert by editing it in place instead of posting again. | §18 |
| **Rank** | Six weighted components → 0–100 → CRITICAL / HIGH / MODERATE / LOW / IGNORE. Internal only; never shown. | §19 |
| **Assess impact** | Could this move SPX / rates / the dollar / broad risk? Decides trading-channel eligibility. | — |
| **Route** | `#scout-news` always; both trading channels together when the event clears the market-impact bar. | — |

### Deduplication in practice

```
POST A   US AND IRAN REACH DEAL              →  ┐
POST B   U.S. AND IRAN HAVE REACHED AGREEMENT →  ├─  ONE EVENT
POST C   AXIOS: US, IRAN REACH AGREEMENT      →  ┘
```

Wire-service prefixes are stripped, `U.S.` normalises to `US`, and the shared
entity set (`US`, `IR`) plus a time window collapses the three into a single
alert. The extra reports are not discarded — each independent source raises the
event's corroboration count, which feeds the credibility component of the score.

### Ticker extraction

The failure mode this module exists to prevent is `META-ANALYSIS` becoming `$META`.

Every entry in `config/security-master.csv` carries an ambiguity level:

- **`safe`** — `NVDA`, `AVGO`, `GOOGL`. Not English words. A bare uppercase match is allowed.
- **`ambiguous`** — `META`, `ALL`, `KEY`, `CAT`, `HOOD`, `OPEN`. Requires a cashtag, a company-name hit, or corporate context within six tokens.
- **`blocked`** — `F`, `T`, `X`, `GO`, `ON`, `IT`. Never bare-matches. Cashtag or full name only.

The tokenizer keeps hyphenated compounds as a single token, so `META-ANALYSIS`
never produces a `META` candidate in the first place. All-caps text — which is
normal for a newswire headline, not a signal of anything — does not suppress
matching, but inside an all-caps segment only `safe` symbols and name matches are
eligible. Every match records how it was found (`CASHTAG`, `NAME`, `BARE_SYMBOL`)
so a false positive is diagnosable from `#scout-raw` rather than a mystery.

---

## No API keys required

Scout's three production ingestion paths need no paid API and no credential
beyond the two webhook tokens:

```
X webhooks ───────┐
Discord forwarder ─┼──→ SCOUT ──→ normalize → dedupe → classify → score
RSS (public) ─────┘                        → attribute → route → Arbor
```

`X_BEARER_TOKEN` is optional and **absent by default**. With it unset Scout does
not register the X polling adapter at all: no failed polls, no health noise, no
cost. Boot reports it plainly:

```
X API: NOT CONFIGURED (no polling; X arrives by webhook/relay)
ingestion started  adapters=["rss","edgar","manual"]
```

The X accounts in `config/sources.yaml` stay **enabled** even though nothing
polls them. They are not dead weight — they carry the `qualityScore`,
`noiseScore` and `org` the scorer and the provenance layer read whenever one of
those accounts reaches Scout through the webhook or the Discord relay. Being
unpollable and being unused are different things.

Verified with every API variable absent: boots with 0 errors, X webhook accepts,
Discord webhook accepts, the same story from both collapses to one alert, and
routing reaches the correct destination channels.

---

## Discord as an intelligence source

A second ingestion source alongside the X webhook, feeding the **same** pipeline
— same dedupe, same classifier, same symbol extraction, same six-component
scorer, same market-impact test, same routing. Being on Discord earns an event
nothing and costs it nothing.

```
X webhook ─┐
           ├─→ NORMALIZE → DEDUPE → CLASSIFY → RANK → ROUTE → #scout-news
Discord ───┘                                                  #trading-floor
                                                              #spx-trading → Sprout
```

### Two ways in

**The intake channel.** Scout's own bot reads a channel you control and treats
what lands there as intelligence. It needs only ordinary permissions — View
Channel, Read Message History, Read Message Content, Send Messages — plus the
MESSAGE CONTENT intent in the developer portal. Post or forward anything into
it and it becomes an input. No bridge, no API key, no credential beyond the bot
token Scout already has.

**An authorized bridge.** A bot the server owner installed, an official or
partner feed, or any relay you are permitted to run POSTs to
`/webhook/discord`. `DiscordIntelProvider` in
`src/ingest/discordIntel/types.ts` is the seam.

```
intake channel   ─┐   (Scout's own bot, ordinary permissions)
                  ├─→ allowlist → queue → the same pipeline
authorized bridge ┘   (POST /webhook/discord)
```

### What Scout does not do

Scout does not read Discord servers it has not been invited to by automating a
personal account. A user token, session cookie, browser replay or self-bot
violates Discord's terms and gets the account terminated — taking the servers,
the intake channel and Scout's own feed down with it. Scout implements none of
it: no user tokens, no session replay, no browser automation, no undocumented
gateway use. **This holds regardless of who is willing to accept the risk**;
the failure mode is the loss of the very access it was meant to buy.

Three permitted routes exist for a server Scout is not in, in order of how
little work they need afterwards:

1. **Follow the channel.** If it is an Announcement channel, Discord's own
   channel-following mirrors it into a channel Scout reads — automatically,
   with the original author and a link back to the source intact. Nothing is
   forwarded by hand. Scout detects these (`relayMethod: crosspost`) and treats
   the attribution as fully preserved. Try this first.
2. **Ask the server owner** for a bot invite or an outgoing webhook.
3. **Forward into the intake channel** yourself. See the attribution rules
   below for what that costs.

### Attribution through a relay

A forwarded message has two accounts attached: whoever originally said it and
whoever carried it the last hop. Only the first is a source, and **Scout never
promotes the carrier into the byline.** When the original author cannot be
recovered, the event is recorded as `unattributed via <carrier>` — an honest
blank rather than a plausible wrong answer, which on a trading alert is the
worse of the two.

What survives depends on how it arrived:

| How it arrived | Author | Origin | Original timestamp |
| --- | --- | --- | --- |
| `crosspost` — Discord channel-following | ✅ | ✅ | ✅ |
| `embed_author` — a relay bot that stamps the byline | ✅ | ✅ | ✅ |
| `text_prefix` — `Forwarded from X in #y:` | ✅ | partial | — |
| `forward_snapshot` — Discord's native forward | ❌ | ✅ | ✅ |
| `message_link` — a bare permalink | ❌ | ✅ | — |
| `direct` — posted by its own author | ✅ | ✅ | ✅ |

Discord's native forward is the one that loses the author: the API sends the
content, embeds and original timestamp, and deliberately omits who wrote it.
Scout reports that split rather than collapsing it — such an event still
publishes and still routes on its content, it simply carries no byline.

Forwarding is a **hop, not a publication**. The freshness gate reads the
original timestamp, so a headline forwarded an hour late is an hour old, and
catching up on yesterday's reading does not manufacture a wire full of fresh
trading events.

### Configuration

`config/discord-sources.yaml` is an **allowlist**. A message from an
unconfigured channel is rejected — not deprioritised.

```yaml
channels:
  - id: "1234567890123456789"
    sourceId: discord:flow-alerts     # must start `discord:` — provenance depends on it
    intake: true                      # Scout's own bot reads it; omit for a bridge
    qualityScore: 85
    authors:                          # optional; empty accepts every author
      - name: unusual_whales_crier
        qualityScore: 90
      - name: OwlsKeyLevelsBot
```

An author allowlist on an intake channel matches whoever **posts in that
channel** — for a forward, the forwarder. It controls who may feed Scout, which
is a different question from who originally said the thing.

**No channel may be both a source and a destination.** Scout would publish an
alert into it, read that alert back as intelligence and re-publish, and the loop
would look from the outside like a very busy news day. The loader rejects the
overlap at boot, and the listener additionally ignores Scout's own messages.

Each channel becomes a row in `sources`, so `qualityScore` feeds the same
`sourceQuality` component an X account uses. It changes how a message competes.
It cannot bypass classification, the noise filters or the market-impact test,
and **nothing here can force a message into `#trading-floor`.**

`DISCORD_INTEL_TOKEN` authenticates the endpoint and must differ from
`SCOUT_WEBHOOK_TOKEN` — one goes to the X relay operator, the other to whoever
runs the Discord bridge, so neither can push into the other's source.

### Publication time

A Discord message carries a real timestamp, and Scout uses it — most upstream
first: an embed's own timestamp, then the original message's timestamp when a
forward preserved it, then the message's own. A relay bot usually stamps the
embed with the upstream event time rather than when it got round to posting, and
a forward carries the original's time rather than the forward's. If nothing
supplies a timestamp at all, `publishedAt` is **null** and the event
reaches `#scout-news` while being withheld from Sprout. The receipt time is
never promoted, exactly as on the X path.

### Provenance

Dedupe collapses the same story across sources, so an event can have more than
one origin — and "DISCORD" is not a useful answer to which. The feed that
actually said it is what an operator judges, so each contributor is recorded
individually and `#scout-raw` names them:

```
ACCEPTED
source      Walter Bloomberg (@DeItaone)
sources     OwlsKeyLevelsBot + @DeItaone
first       2026-08-10T14:47:00.000Z
confirmed   2 sources (independent)
  · discord author=OwlsKeyLevelsBot  channel=market-news  server=88  at=2026-08-10T14:47:00.000Z
  · x       account=@DeItaone  at=2026-08-10T14:49:00.000Z
```

`first` is the **earliest report across all contributors**, not when Scout heard
about it — so a Discord bot beating the wire by two minutes is visible as
exactly that. `confirmed` counts distinct sources; a source repeating itself
refines its own record rather than counting twice.

Stored on the cluster in `events.contributors`, so it survives dedupe and
restart. Clusters written before this existed fall back to `X + DISCORD` from
bare source ids.

Backend-only, like everything else in that channel — the alert is a four-field
`RenderableAlert` and structurally cannot carry it. `/metrics` carries the
intake counters under `.discord`.

---

## Sources

The entire watchlist is `config/sources.yaml`. Add or remove an account there and
run `npm run sources:sync` — no code changes (§36).

```yaml
- id: x:deltaone
  name: Walter Bloomberg
  handle: "@DeItaone"
  sourceType: x
  priority: 100
  enabled: true
  qualityScore: 98
  noiseScore: 2
  filterProfile: standard
```

Four layers ship configured:

**Tier 1 newswire** — `@DeItaone`, `@FirstSquawk`, `@financialjuice`, `@LiveSquawk`, `@tier10k`.

**Newsrooms** — Bloomberg's verticals, Reuters, Reuters Business, AP. Reporting
accounts, never personality accounts.

**Official data** — the Fed (press, monetary policy, speeches, testimony), BLS,
BEA, Treasury, the SEC, and the ECB / BoE / BoJ / BoC / RBA. Delivered by RSS
rather than X: these are the primary release feeds, they need no API key, and
they carry the highest credibility weight in the scorer.

**EDGAR** — 8-K, SC 13D, and (staged off) Form 4, with a materiality classifier
in front of them so that most filings never alert at all.

Two accounts run `filterProfile: strict` — `@KobeissiLetter` and `@zerohedge`.
They are fast on real headlines and heavy on framing, so the factuality gate must
return `FACTUAL_NEWS` before anything from them reaches the wire.

### Verification

`config/sources.yaml` is a starting point, and the spec is explicit that a handle
should not be trusted just because a list somewhere claims it exists.
`npm run sources:verify` resolves every X handle through the API and requests
every feed URL, marks each row verified or not, and prints what failed. Run it
before enabling anything, and after any upstream reorganisation.

**The shipped list has not been network-verified.** The X handles are the ones
named in the specification and the feed URLs are the documented endpoints for
each agency, but neither has been confirmed against the live services in this
repository — run `npm run sources:verify` before trusting any of them, and set
`enabled: false` for anything that does not resolve.

### Curation

The rule is signal density, not account count. An account posting 20 times a day
with 18 useful posts beats one posting 100 times with 5. Scout tracks
`useful_post_ratio` per source and reports drift:

```bash
npm run scout sources:report 30
```

The report suggests `KEEP` / `REVIEW` / `REMOVE`, and stops there. It does not
adjust its own thresholds — §28 is deliberate about collecting statistics for
human review rather than self-tuning, because a bot that quietly changes what it
considers important is a bot you cannot reason about.

---

## Channels

```
#scout-news       the complete qualified feed — every accepted event
#trading-floor    every major market-moving event
#spx-trading      the same major events, for anything that can move SPX
#scout-raw        admin — every decision, accepted or rejected
#scout-system     admin — source health, latency, reports
```

**The core rule: the two trading channels move together.** There is no
configuration in which a critical macro, Fed, geopolitical or government event
lands in `#scout-news` while the trading channels miss it, and none in which one
trading channel receives an event the other does not. A test asserts both.

Whether an event clears that bar is decided by `assessMarketImpact` — could this
realistically move SPX / SPY / ES / NDX / QQQ, US rates, the dollar, or broad risk
sentiment? By severity:

| Band | Routing |
|---|---|
| **CRITICAL** | always `#scout-news` + both trading channels |
| **HIGH** | both trading channels when market-wide or SPX-relevant |
| **MODERATE** | trading channels only on genuine broad relevance |
| **LOW** | `#scout-news` only |

**The event decides, never the source.** The same relay account produces both
outcomes minutes apart:

```
"Trump says happy birthday to someone"   → #scout-news
"TRUMP ANNOUNCES 25% TARIFF ON STEEL"    → #scout-news + #trading-floor + #spx-trading
```

There is deliberately no `DeItaone → trading-floor` rule anywhere in the code.

The original per-category channels (`#scout-macro`, `#scout-fed`, …) are still
supported as an extra fan-out — set `CATEGORY_CHANNELS_ENABLED=true`.

`#scout-raw` is the debugging surface and the only place the hidden fields
appear — source, handle, URL, ingestion time, the full score breakdown, the
tickers with their evidence, and the exact rule that rejected a post.

### Scheduled reminders

`config/calendar.yaml` drives reminders ahead of known releases, at one day, one
hour, and fifteen minutes out:

```
SCOUT REMINDER

CPI TOMORROW

8:30 AM ET

EXPECTED IMPACT: CRITICAL
```

These go to `#scout-news` and both trading channels. Fired reminders are
persisted, so a restart does not repeat them.

---

## Webhook ingestion

An upstream source can push posts straight into Scout:

```
POST https://<scout-domain>/webhook/news
Authorization: Bearer <SCOUT_WEBHOOK_TOKEN>
X-Idempotency-Key: x-2058552301120360937        (optional; the id is used otherwise)

{
  "v": 1,
  "id": "x-2058552301120360937",
  "platform": "x",
  "source": "DeItaone",
  "handle": "@DeItaone",
  "text": "NO NUCLEAR IRAN\n\nTrump called the Obama-era Iran nuclear deal...",
  "published_at": "2026-05-24T17:14:00Z",
  "url": "https://x.com/DeItaone/status/2058552301120360937"
}
```

Truth Social uses the same endpoint with `"platform": "truth_social"`.

The request is authenticated (constant-time compare, `401` on failure),
validated (`400` on a malformed payload), persisted, queued, and acknowledged
with **`202`** — it never waits for Discord, Sprout, classification or any
external call. A retry of an already-accepted event returns `200 duplicate`
without producing a second alert.

**Nothing downstream knows it was a webhook.** The event joins the identical
processor a relayed post uses — same dedupe, classifier, router, renderer,
calendar and Sprout path. There is no webhook-specific branch anywhere after
ingestion, which is the whole point:

```
Webhook ──────────────┐
                      ↓
Discord relay ───→ Normalizer → Dedupe → Classifier → Router ─┬→ #scout-news
                                                              ├→ #trading-floor
                                                              ├→ #spx-trading
                                                              └→ Sprout
```

Dedupe is by the supplied id, normalised to the same key the relay path derives
from a URL (`x-123`, `x:123` and a bare `123` all become `x:123`), enforced by a
database uniqueness constraint. The same post pushed twice, sent by two upstream
sources, arriving after a restart, or seen through **both** the webhook and the
Discord relay produces exactly one canonical event and one alert.

`id` does **not** have to match the number in `url`. A relay that keys off its
own database can send `"id": "relay-internal-000123"` with a normal X permalink;
Scout stores the pushed text under the id it was given and retrieval asks for
that id, not one re-derived from the URL. (It used to re-derive, which meant a
relay numbering things its own way had its text stored under one key and looked
up under another — the event then fell through to an X API resolver that on a
no-key deployment does not exist, and failed as `FAILED_RETRIEVAL` while Scout
was holding the text all along.)

`published_at` is stored exactly as supplied and is never replaced by the
receipt time — `received_at` is its own column. An event with no publication
time still appears in `#scout-news` but is held from Sprout with the reason
`publication time unknown`.

Webhook counters and liveness appear in `/metrics`. Silence there is reported as
`NO_RECENT_EVENTS`, never as an outage: an upstream source with nothing to say
looks exactly like a quiet news period.

---

## 24/7 URL ingestion

Scout watches configured Discord channels for X post URLs and processes them as
they arrive — event-driven, never polling channel history.

```
Discord message → detect URL → normalise → dedupe → resolve → classify → route
```

Every supported domain normalises to one id, which is the deduplication key:

```
https://x.com/DeItaone/status/2058552301120360937         ─┐
https://twitter.com/DeItaone/status/2058552301120360937   ─┼→ x:2058552301120360937
https://x.com/DeItaone/status/2058552301120360937/photo/1 ─┘

https://truthsocial.com/@realDonaldTrump/posts/113456789  ──→ truth:113456789
```

The same post relayed through five channels, twice in one channel, or again after
a redeploy produces exactly one event.

### A restart cannot lose an accepted post

A relayed post's content arrives exactly once, in a Discord message Scout never
sees again — the listener subscribes to new messages and does no history
scraping. So the relaying message is written into the job row itself,
`processing_jobs.relay_payload`, **in the same INSERT that creates the job**.
A queued job is recoverable entirely from SQLite; nothing about processing it
depends on the process that accepted it still being alive.

```
message arrives ─→ INSERT job + payload  (one statement, on disk)
                          │
             ┌────────────┴────────────┐
      processed now              restart, then processed
             │                          │
             └────────────┬─────────────┘
                    same alert, once
```

The payload is released only when the job completes successfully. A failing or
retrying job keeps it — that is precisely when it is still needed, either for
the next attempt or for a later relay of the same post that reopens the row.
There is deliberately no in-memory cache of it: a second copy is a second thing
to be wrong.

### Retrieval

`PostResolver` is an interface, and nothing outside `src/ingest/resolver.ts`
mentions a credential. Provider order is deliberate:

1. **The relay itself.** A permitted relay usually posts the content with the
   link, and the parser reads attribution, headline and body straight out of it.
   No request, no credential — this is the primary MVP path.
2. **X API v2**, only if configured, and only for links relayed without text.

```
Macro Alert (@DeItaone):          →  author       Macro Alert
                                     handle       @DeItaone
NO NUCLEAR IRAN                   →  headline     NO NUCLEAR IRAN
                                     body         Trump called the deal…
Trump called the deal…               published_at null  (none was stated)
https://x.com/DeItaone/status/…   →  post id      x:2058552301120360937
```

The parser will not invent a publication time. If the relay did not state one,
`published_at` stays `NULL` — the relay's message time is when Scout *heard*
about the post, and treating it as publication time is how a recycled headline
becomes a fresh trading signal.

There is deliberately nothing here that works around authentication, rate
limits, CAPTCHAs or paid-tier restrictions. When no configured method can
retrieve a post, the job ends as `FAILED_RETRIEVAL` and the event is preserved
for retry and diagnostics.

**Truth Social runs the identical path.** `truthsocial.com/@user/posts/<id>`
normalises to `truth:<id>` and flows through the same detector, dedupe,
classifier and router. It is a platform, not a special case.

**Reliability.** A bounded worker pool (`INGEST_CONCURRENCY`) means a hundred URLs
arriving at once cannot let one slow retrieval block the wire. Every external
call has a timeout. Retries follow a fixed schedule — immediate, 1s, 3s, 10s —
and then stop. The queue is persisted, so jobs a crashed process left mid-flight
are picked up on boot rather than lost or duplicated.

**Publication time is never faked.** If the genuine publication time is
unavailable, `published_at` stays `NULL`; the Discord receive time is recorded
separately and never promoted into it. The downstream trading feed enforces its
own freshness window (`SPROUT_MAX_AGE_MINUTES`) against publication time alone,
so a recycled headline cannot manufacture a fresh trading event.

**Source filtering.** `ALLOWED_X_ACCOUNTS` restricts which accounts enter the
production pipeline, so a URL pasted by an arbitrary user does not become a
trading alert.

---

## Operations

**Latency** is tracked in four stamps — `event_time`, `ingestion_time`,
`processing_time`, `discord_time` — because a newswire that is right and late is
not much of a newswire.

```
AVG LATENCY   142 ms
P95 LATENCY   410 ms
P99 LATENCY   780 ms
```

**Source health** is the operational rule that matters most: a broken feed must
never read as a quiet news environment. Every source carries a state —
`ACTIVE` / `DELAYED` / `STALE` / `DISCONNECTED` / `ERROR` — derived from its own
expected cadence, and any transition into a bad state raises a
`SOURCE HEALTH WARNING` in `#scout-system`. If `X_BEARER_TOKEN` is missing, the X
sources report `DISCONNECTED` rather than silently returning nothing. Anything
consuming Scout downstream can therefore distinguish "no news" from "no feed".

**HTTP surface** for a hosted deployment:

```
GET  /health        liveness
GET  /ready         503 when a dependency ingestion needs is down
GET  /metrics       queue depth, latency percentiles, feed health, throughput
POST /webhook/news  authenticated push ingestion (202 on accept)
POST /admin/replay  authenticated Sprout recovery trigger
```

`/ready` failing is the deployment-level version of the same principle as source
health: being unable to receive news must never look like there being no news.

**Retention.** Every table Scout appends to has a ceiling, pruned on a
schedule — latency samples, completed jobs, aged events and posts. The `posts`
table is deliberately exempt: it is the durable record of what has already been
processed, and losing a row there would make Scout repost an old item as new.

**Replay** re-runs stored raw posts through the current classifier, so a filter
change can be measured against real traffic before it ships:

```bash
npm run replay 500
```

It prints the alerts that would have fired and a histogram of rejection reasons.

---

## Layout

```
config/
  sources.yaml           the watchlist — the only place accounts are defined
  taxonomy.yaml          category keywords, noise rules, entity surface forms
  security-master.csv    ticker dictionary with per-symbol ambiguity levels
src/
  core/types.ts          every shared contract, including RenderableAlert
  config/                env + config loading, zod-validated
  db/                    schema and repositories (better-sqlite3)
  ingest/                adapters (x, rss, edgar, manual) + the poll manager
    urls.ts              URL detection and x:<post_id> normalisation
    resolver.ts          PostResolver abstraction + providers
    queue.ts             persisted, bounded-concurrency job queue
    discordListener.ts   event-driven URL detection
    urlWorker.ts         resolve → persist → pipeline, + freshness gate
  calendar/              scheduled release reminders
  server/                /health, /ready, /metrics
  pipeline/
    normalize.ts dedupe.ts cluster.ts score.ts marketImpact.ts
    classify/            category, noise, factuality, earnings, filings
    extract/             tickers, entities
  render/                alert.ts (austere) and raw.ts (everything)
  discord/               client, router, publisher
  health/                monitor, latency, stats
  cli/                   operator commands
```

---

## Scout is judged on four things

**Speed** — how quickly it detected the event.
**Accuracy** — whether the information was correct.
**Relevance** — whether a trader would care.
**Noise** — how many useless alerts it sent.

The fourth is the one that decides whether the product is any good. Fifty alerts
that all matter beat five hundred that mostly do not, and every default in this
repository is set accordingly. If Scout is too quiet, raise `MIN_PUBLISH_SCORE`
downward; if it is too noisy, the source report will usually name the account
responsible before the thresholds need touching.


---

## Sprout

Scout is the information layer; Sprout consumes normalized events for
news-aware trading restrictions. Set `SPROUT_URL` (and `SPROUT_TOKEN`) to turn
the hand-off on — unset is the normal MVP state, and every Sprout delivery is
then recorded as `SKIPPED`.

Only events that pass the freshness gate are sent. A post whose publication time
is unknown or outside `SPROUT_MAX_AGE_MINUTES` may still appear in
`#scout-news`, but handing it to a trading system would let a recycled story
open a new blackout. Sprout being unreachable never blocks the Discord wire; the
delivery is recorded as `FAILED` and the alert goes out regardless.

Unlike a Discord alert, the Sprout payload *does* carry severity and market
relevance — a trading system is exactly who those are for.

### Replaying failed deliveries

The retry schedule is immediate / 1s / 3s / 10s. A Sprout outage longer than
that leaves deliveries at `FAILED` with nothing to re-drive them:

```bash
npm run deliveries:replay                      # every FAILED Sprout delivery
npm run deliveries:replay -- --since 30m       # only the last 30 minutes
npm run deliveries:replay -- --id x:123456     # one event or provider post id
npm run deliveries:replay -- --dry-run         # report only, send nothing
npm run deliveries:replay -- --skipped         # re-check ones held by freshness
```

Two properties matter more than the command itself.

**It re-runs the freshness gate against the ORIGINAL publication time.** An
event that has aged out during the outage is skipped, not force-fed to a trading
system — replaying a stale headline is precisely what the gate exists to
prevent. The reason is recorded on the delivery row.

**It cannot produce a second Discord alert.** The module touches Sprout and the
delivery log and nothing else; it has no dependency on the publisher at all.
The original event id is reused as the idempotency key, so a delivery that
landed just before the connection dropped is collapsed by Sprout rather than
counted twice.

The report separates delivered, skipped-stale, skipped-no-timestamp,
still-failing and unresolvable (an event that has aged out of retention), and
exits non-zero only when something is still failing — a skip is a correct
outcome, not an error.

### Automatic recovery

Recovery runs on its own, every `REPLAY_INTERVAL_MINUTES` (default 5), over the
last `REPLAY_WINDOW_MINUTES` (default 60). The CLI above stays available for
manual work and `--dry-run`.

**It runs inside the web service, not as a Render cron job**, and that is a
deliberate correction rather than a shortcut. A Render cron gets its own
container, and a Render disk attaches to exactly one service — so a cron running
`deliveries:replay` could not see the database at all. It would report "nothing
to replay" on every run while failed deliveries piled up. A silent no-op is
worse than no recovery, so the schedule lives where the data does.

If you would rather drive it externally, `POST /admin/replay` does the same pass
over HTTP, authenticated with `SCOUT_ADMIN_TOKEN`. Leave that unset and the
endpoint does not exist. It deliberately does **not** fall back to
`SCOUT_WEBHOOK_TOKEN`: that token is handed to the upstream relay, and an
ingestion credential should not authorize an operational endpoint.
`render.yaml` carries a commented cron block that calls it.

**Overlapping runs cannot double-deliver.** Each pass *claims* rows in the
database, so two runs take disjoint sets; a claim abandoned by a crashed run is
reclaimed after ten minutes, and an unresolvable row releases its claim rather
than becoming permanently invisible. Tests drive two concurrent runs and assert
each event reaches Sprout exactly once.

**A pass cannot outlive its own claims.** With Sprout degraded, a hundred rows
each burning the full request timeout would take longer than the stale-claim
window — so the next run would start re-sending rows the first was still
working through. Passes are bounded and hand back what they did not reach,
reported as `deferred` rather than silently capped.

**A delivery interrupted mid-flight is still recoverable.** The outcome row is
written when the Sprout request settles, which during an outage is ten seconds
later. A deploy or a crash inside that window would leave no row at all, and the
replay would be blind to exactly the events the outage caused. So a `PENDING`
row is written *before* the request; one still sitting there five minutes later
is a delivery that started and never reported back, and the replay picks it up.
The freshness gate is re-run on it like anything else — recovering a delivery is
not a licence to send stale news to a trading system.

Every pass logs the six counts an operator needs:

```json
{"msg":"sprout replay complete","found":7,"delivered":4,"skippedStale":2,
 "skippedUnknownTime":1,"stillFailing":0,"unresolvable":0}
```

---

## Deployment

`render.yaml` is a working blueprint. Two things it will not let you get wrong:

- **Not the free instance type.** Free instances sleep on idle, and a wire that
  is asleep at 3am is precisely the failure this design exists to prevent.
- **A persistent disk for the database.** Without one, every deploy would wipe
  the processed-post set and Scout would repost recent history on boot.

Set `DATABASE_PATH` to a path on the mounted disk, point `healthCheckPath` at
`/health`, and put every credential in the dashboard rather than in the file.

### Proving the disk is actually attached

This is the one misconfiguration that is invisible from the outside. A Scout
whose database sits on ephemeral storage boots cleanly, passes its health check,
and then reposts a morning's worth of old headlines into the trading channels as
breaking news — because the dedupe history, the delivery log and the
calendar-fired keys were all wiped by the deploy.

Configuration cannot prove a disk is mounted, so Scout does not ask you to trust
it. It keeps a boot counter **inside** the database. The counter can only climb
if the file survived:

```bash
curl -s https://<scout-domain>/metrics | jq .storage
```

```json
{
  "path": "/var/data/scout.db",
  "boots": 4,
  "firstBootAt": "2026-08-02T13:41:02.881Z",
  "lastBootAt": "2026-08-09T09:15:44.019Z",
  "durability": "PERSISTENT",
  "retained": { "posts": 1284, "newsEvents": 1102, "deliveries": 940,
                "calendarFired": 22, "jobs": 1284 }
}
```

**Redeploy once and check it again.** `boots` going 1 → 2 with `durability`
reading `PERSISTENT` is the proof. If it still reads `boots: 1` after a redeploy,
the disk is not attached — fix that before letting Scout near a trading channel.

Scout also logs the same verdict on every boot and warns loudly, in the log
stream and in `#scout-system`, when `DATABASE_PATH` points somewhere that cannot
possibly be a mounted disk — a relative path, anything under `/opt/render/`,
anything under `/tmp`.


---

## Notes for whoever runs this

A few behaviours are deliberate and worth knowing before you tune anything.

**The X request budget is arithmetic, not a guess.** Scout polls every enabled
X source on each tick, so requests per 15-minute window =
`enabled_x_sources × (900000 / X_POLL_INTERVAL_MS)`. The shipped watchlist has
~14 enabled X sources, so the default 90s interval costs 140 requests against a
budget of 180. Lowering the interval without raising the budget does not break
anything — Scout rotates which sources it polls and skips the rest — but
low-priority accounts will be covered less often.

**Two Discord connections, on purpose.** The publisher connects with the Guilds
intent alone. The URL listener needs the privileged MessageContent intent, and
Discord *rejects login outright* when that is not enabled in the developer
portal. Sharing one connection would mean a missing portal checkbox takes down
publishing too; as it is, URL ingestion degrades and everything else carries on.

**A cold start does not replay history.** On a feed's first poll Scout has no
watermark, so it emits only items published in the last 15 minutes. A restart
during a breaking story still catches it; a restart on a quiet morning does not
dump a backlog into the channels.

**The score is never shown.** It exists to decide routing and to explain
decisions in `#scout-raw`. `assertNoLeakedMetadata` refuses to publish any alert
carrying a score, band, confidence or backend label — while still allowing the
percentages that are part of the news. Both directions are covered by tests,
including the case that a real headline like
"US CONSUMER CONFIDENCE: 102.6 VS 100.4 EXPECTED" must still publish.


---

## Going live

Order matters — each step depends on the one before it.

**Step 0 — the two settings that stop a boot.** Both fail loudly rather than
silently, which is the point, but knowing them in advance saves a deploy cycle:

- `DISCORD_BOT_TOKEN` must be set (or `DRY_RUN=true`).
- A **general news destination** must exist: `DISCORD_CHANNEL_NEWS`, or
  `destinations.general` in `config/discord-sources.yaml`. It ships unset
  because the channel that used to hold it is now the intake channel, and one
  channel cannot be both — Scout would read its own alerts back in.
  `npm run discord:setup` creates the missing channel and prints the id.

Everything else is optional. Scout runs with **no API key at all**.

1. Deploy Scout (`render.yaml`; **not** the free instance type, and keep the disk).
2. **Prove the disk.** Redeploy once, then
   `curl -s https://<scout-domain>/metrics | jq .storage`. `boots` must read 2 or
   more and `durability` must read `PERSISTENT`. Still `1`? The disk is not
   attached, and every step below this one is built on sand — fix it first.
3. Enable the **Message Content** intent for the bot in the Discord developer
   portal. Without it the relay path only sees links Discord expanded into an
   embed. The webhook path does not need it.
4. Set the real channel IDs — `npm run discord:setup` creates any that are
   missing and prints them in the exact variable names to paste back.
5. Set `ALLOWED_X_ACCOUNTS` to the handles your relay actually posts. Empty
   means every account is accepted, so anyone who can post in a watched channel
   can reach `#trading-floor` and `#spx-trading`. Scout warns on boot, in the
   log stream and in `#scout-system`, if this is empty while it is watching
   channels — but do not deploy relying on the warning.
6. Set `SCOUT_WEBHOOK_TOKEN` and give the upstream source
   `https://<scout-domain>/webhook/news` plus that token.
7. Set `SPROUT_URL` and `SPROUT_TOKEN`.
8. Populate `config/calendar.yaml` from the **published** BLS and Fed schedules.
   It ships empty on purpose: a reminder routes to `#scout-news`,
   `#trading-floor` **and** `#spx-trading`, so a guessed date announces
   "CPI TOMORROW" to the trading channels for a release that is not happening.
   Every entry needs an explicit UTC offset. Leaving it empty is a valid
   configuration — it simply means no reminders.
9. `npm run sources:verify`. X checks report SKIPPED without a credential; that
   is expected and is not a deploy blocker.
10. Send one test webhook and confirm it appears in `#scout-news`.
11. Send a major-event webhook (a CPI or FOMC headline) and confirm it reaches
    `#trading-floor` **and** `#spx-trading`.
12. Confirm Sprout received it.
13. Send the identical event again — expect `200 duplicate` and no second alert.
14. Stop Sprout, send an event, confirm Discord still publishes and the delivery
    is recorded `FAILED`.
15. Restart Sprout and wait one replay interval; confirm still-fresh events
    recover on their own.
16. Confirm a stale event is skipped rather than delivered — `/metrics` and the
    replay log both show the reason.

Steps 10–13 are automated. Against a running instance:

```sh
SMOKE_BASE=https://<scout-domain> \
SCOUT_WEBHOOK_TOKEN=… DISCORD_INTEL_TOKEN=… SCOUT_ADMIN_TOKEN=… \
npm run smoke
```

It exercises both webhook paths and their authentication boundary, checks that
the X token cannot push into the Discord source, verifies idempotency on a
repeat, confirms no configured secret appears in `/metrics`, and prints what the
pipeline actually did. A check whose token is unset is skipped, not failed.
Exits non-zero on any failure, so it works in CI.

Then let it run through real market hours. What is worth having next is latency
and error data from live traffic, not more tests.

### What to watch once it is live

Everything below is one request: `curl -s https://<scout-domain>/metrics | jq`.
The window is 24h.

| Signal | Field |
|---|---|
| Is the disk actually persisting | `.storage.durability`, `.storage.boots` |
| Source → Scout latency | `.latencyMs.byStage.sourceToScout` |
| Scout processing → Discord latency | `.latencyMs.byStage.scoutToDiscord` |
| End-to-end latency | `.latencyMs.byStage.total` |
| Scout → Sprout latency | `.sprout.latencyMsAvg`, `.sprout.samples` |
| Rejected webhooks | `.webhook.rejectedTotal` |
| Duplicates collapsed | `.events.duplicatesTotal` |
| Stale events held back | `.events.staleTotal` |
| Events with no publication time | `.events.unknownPublicationTimeTotal` |
| Sprout failures | `.sprout.failedTotal`, `.deliveriesByDestination.sprout` |
| Replay recoveries | `.replay.recoveredTotal`, `.replay.runsTotal` |
| Feeds that have gone quiet or broken | `.sources.degraded` |

Two of these are worth a second look rather than a glance:

**`events.staleTotal` climbing** means news is arriving too late to trade, not
that Scout is broken. Check `latencyMs.byStage` next — if `sourceToScout` is the
large number, the delay is upstream of Scout and no amount of tuning here will
fix it.

**`events.unknownPublicationTimeTotal` climbing** means an upstream source
stopped sending timestamps. Scout will not guess one, so those events reach
`#scout-news` and are deliberately withheld from Sprout. That is a conversation
with the source, not a code change.

**Always read `count` alongside `avg` on `latencyMs.byStage`.** `sourceToScout`
and `total` are measured from the source's stated publication time, so an event
that never had one contributes no sample rather than a 0ms one. A relay that
stops sending timestamps therefore shows `sourceToScout.count` falling toward
zero, not a latency that magically improves. `scoutToDiscord` is always
measurable — it is the part Scout is responsible for — so a large gap between
its count and `sourceToScout`'s count is itself the finding: Scout is fast, and
you cannot see how fast the source is.

`replay.deferredTotal` above zero means a pass ran out of its time budget and
handed work to the next one — expected while Sprout is degraded, and worth
investigating if it persists once Sprout is healthy.
