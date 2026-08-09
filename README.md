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

Scout runs without an X API key. The RSS and EDGAR layers — the Fed, BLS, BEA,
Treasury, the SEC, and the central banks — need no credentials, and they are the
highest-credibility sources in the system. Add `X_BEARER_TOKEN` to turn on the
newswire accounts.

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

## 24/7 URL ingestion

Scout watches configured Discord channels for X post URLs and processes them as
they arrive — event-driven, never polling channel history.

```
Discord message → detect URL → normalise → dedupe → resolve → classify → route
```

Both domains normalise to one id, which is the deduplication key:

```
https://x.com/DeItaone/status/2058552301120360937        ─┐
https://twitter.com/DeItaone/status/2058552301120360937  ─┼→  x:2058552301120360937
https://x.com/DeItaone/status/2058552301120360937/photo/1 ─┘
```

The same post relayed through five channels, twice in one channel, or again after
a redeploy produces exactly one event.

**Retrieval** goes through a `PostResolver` abstraction so the provider can be
swapped without touching the pipeline. Two ship: the X API v2, and a fallback
that uses text the relaying message already carried. There is deliberately
nothing here that works around authentication, rate limits, CAPTCHAs or paid-tier
restrictions — when the configured method cannot retrieve a post, the job ends as
`FAILED_RETRIEVAL`.

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
GET /health    liveness
GET /ready     503 when a dependency ingestion needs is down
GET /metrics   queue depth, latency percentiles, feed health, throughput
```

`/ready` failing is the deployment-level version of the same principle as source
health: being unable to receive news must never look like there being no news.

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

## Deployment

`render.yaml` is a working blueprint. Two things it will not let you get wrong:

- **Not the free instance type.** Free instances sleep on idle, and a wire that
  is asleep at 3am is precisely the failure this design exists to prevent.
- **A persistent disk for the database.** Without one, every deploy would wipe
  the processed-post set and Scout would repost recent history on boot.

Set `DATABASE_PATH` to a path on the mounted disk, point `healthCheckPath` at
`/health`, and put every credential in the dashboard rather than in the file.
