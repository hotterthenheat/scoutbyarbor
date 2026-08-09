# Scout — Arbor Capital

A private newswire for Discord. Scout ingests a curated set of sources, throws away
the noise, collapses the same story reported five ways into one event, and posts
what is left in a deliberately austere format.

It is not a feed mirror, an aggregator, a chatbot, or a signal generator. The
product is the filtering.

```
X / RSS / EDGAR
      ↓
   INGEST → NORMALIZE → DEDUPLICATE → CLASSIFY → FILTER
                                                    ↓
                          DISCORD ← FORMAT ← RANK ← CLUSTER
```

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
| **Route** | Category home channel, plus `#scout-breaking` above the breaking threshold, plus secondary channels. | §26 |

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

See `docs/source-verification.md` for the results of the verification pass run
against this configuration, including which feed URLs were confirmed live and
which could not be checked.

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
#scout-breaking     score ≥ 90 or band CRITICAL
#scout-macro        #scout-fed        #scout-geopolitics
#scout-markets      #scout-equities   #scout-earnings
#scout-commodities  #scout-options    #scout-crypto
#scout-raw          admin — every decision, accepted or rejected
#scout-system       admin — source health, latency, reports
```

Events fan out rather than broadcast. A critical Fed decision goes to
`#scout-breaking`, `#scout-macro`, and `#scout-fed`. An NVDA earnings beat goes to
`#scout-breaking`, `#scout-equities`, and `#scout-earnings`.

`#scout-raw` is the debugging surface and the only place the hidden fields
appear — source, handle, URL, ingestion time, the full score breakdown, the
tickers with their evidence, and the exact rule that rejected a post.

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
  ingest/                adapters: x, rss, edgar, manual + the poll manager
  pipeline/
    normalize.ts dedupe.ts cluster.ts score.ts
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
