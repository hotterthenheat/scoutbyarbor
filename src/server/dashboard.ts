/**
 * The operator dashboard.
 *
 * Scout's output is Discord; this is the window into everything Discord does
 * not show — whether the disk is real, which feeds are broken and WHY, what the
 * pipeline has done, and a way to push something through it by hand.
 *
 * ── SELF-CONTAINED ON PURPOSE ────────────────────────────────────────────────
 *
 * One HTML string with inline CSS and inline JS. No build step, no bundler, no
 * CDN — a dashboard that fails to load because an external stylesheet 404s is
 * worse than no dashboard, and Scout's whole value is being trustworthy when
 * something is already going wrong.
 *
 * ── WHAT IT WILL NOT SHOW ────────────────────────────────────────────────────
 *
 * Everything here comes from /metrics, which is deliberately secret-free: no
 * tokens, no credentials, no raw payloads, no request headers. The page is
 * readable by anyone who can reach the service, exactly like /metrics, and
 * carries nothing that /metrics does not.
 *
 * Submitting is different, and is the one thing that is authenticated: it puts
 * an event into the trading channels. The token is typed by the operator, held
 * in the browser's localStorage, and never rendered into the page source.
 */

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Scout — Arbor Capital</title>
<style>
  :root {
    --bg:#0b0d10; --panel:#14181d; --line:#232a32; --text:#e6edf3; --dim:#8b98a5;
    --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-size:14px; line-height:1.5; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex;
           align-items:baseline; gap:16px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; letter-spacing:.08em; text-transform:uppercase; }
  .sub { color:var(--dim); font-size:12px; }
  main { padding:24px; max-width:1100px; margin:0 auto; }
  section { margin-bottom:28px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim);
       margin:0 0 10px; font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .card .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  .card .value { font-size:22px; margin-top:6px; }
  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .dim{color:var(--dim)}
  table { width:100%; border-collapse:collapse; background:var(--panel);
          border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--line);
          font-size:13px; vertical-align:top; }
  th { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  tr:last-child td { border-bottom:none; }
  td.err { color:var(--bad); word-break:break-word; max-width:420px; }
  .empty { color:var(--dim); padding:14px; background:var(--panel);
           border:1px solid var(--line); border-radius:8px; }
  form { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
  label { display:block; color:var(--dim); font-size:11px; text-transform:uppercase;
          letter-spacing:.06em; margin-bottom:6px; }
  input,textarea { width:100%; background:#0b0d10; border:1px solid var(--line); color:var(--text);
                   border-radius:6px; padding:9px 11px; font:inherit; font-size:13px; margin-bottom:14px; }
  textarea { min-height:78px; resize:vertical; }
  button { background:var(--accent); color:#06121f; border:0; border-radius:6px;
           padding:9px 18px; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .hint { color:var(--dim); font-size:12px; margin:-8px 0 14px; }
  #result { margin-top:12px; font-size:13px; white-space:pre-wrap; }
  footer { color:var(--dim); font-size:12px; padding:0 24px 32px; max-width:1100px; margin:0 auto; }
  a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Scout</h1>
  <span class="sub">Arbor Capital &mdash; institutional newswire</span>
  <span class="sub" id="clock"></span>
</header>

<main>
  <section>
    <h2>Status</h2>
    <div class="grid" id="cards"></div>
  </section>

  <section>
    <h2>Feeds that are broken</h2>
    <div id="broken"></div>
  </section>

  <section>
    <h2>Feeds that are simply quiet</h2>
    <p class="hint">Reachable, polling fine, nothing published recently. An
      agency that releases twice a month sits here permanently and that is
      correct — it is not a fault, and it is not the same thing as broken.</p>
    <div id="quiet"></div>
  </section>

  <section>
    <h2>Where alerts went</h2>
    <p class="hint">Published means a channel received it. If this is empty
      while events are publishing, the sends are failing &mdash; almost always
      a channel the bot cannot see, or no Send Messages permission there.</p>
    <div id="deliveries"></div>
  </section>

  <section>
    <h2>Why events were dropped</h2>
    <p class="hint">A quiet wire is not the same as a broken one. Scout publishes
      only news whose own publication time is within the freshness window, so
      slow aggregators are declined on purpose &mdash; this is where that shows
      up, alongside duplicates and the noise filters.</p>
    <div id="rejections"></div>
  </section>

  <section>
    <h2>Ingestion routes</h2>
    <div id="routes"></div>
  </section>

  <section>
    <h2>Push an event through the pipeline</h2>
    <form id="ingest">
      <label for="url">X / Truth Social post URL &mdash; optional</label>
      <input id="url" placeholder="https://x.com/DeItaone/status/1234567890" autocomplete="off">
      <p class="hint">A post URL is attributed to the account that wrote it. Paste the post's
        text below as well &mdash; Scout does not fetch X, so the text is what it reads.</p>

      <label for="text">Headline / post text</label>
      <textarea id="text" placeholder="US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED"></textarea>

      <label for="token">Admin token</label>
      <input id="token" type="password" placeholder="SCOUT_ADMIN_TOKEN" autocomplete="off">
      <p class="hint">Held in this browser only. Submitting publishes to your Discord channels,
        so it is the one action here that is authenticated.</p>

      <button id="submit" type="submit">Send through pipeline</button>
      <div id="result"></div>
    </form>
  </section>
</main>

<footer>
  Raw data: <a href="/metrics">/metrics</a> &middot; <a href="/health">/health</a> &middot;
  <a href="/ready">/ready</a>. This page shows only what /metrics shows &mdash; no tokens,
  no credentials, no message content.
</footer>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function card(label, value, cls) {
  return '<div class="card"><div class="label">' + esc(label) + '</div>' +
         '<div class="value ' + (cls || '') + '">' + esc(value) + '</div></div>';
}

function render(m) {
  $('clock').textContent = 'updated ' + new Date().toLocaleTimeString();

  const st = m.storage || {};
  // The single most important field on the page. UNPROVEN is not a failure —
  // it means one boot so far — but EPHEMERAL means state is being lost.
  const durCls = st.durability === 'PERSISTENT' ? 'ok'
               : st.durability === 'UNPROVEN' ? 'warn' : 'bad';
  const src = (m.sources && m.sources.byState) || {};
  const active = src.ACTIVE || 0;
  const rows = (m.sources && m.sources.degraded) || [];
  // Broken means failing to fetch. Quiet means fetching fine and publishing
  // nothing. Counting them together made a healthy wire look like a wreck.
  // Failures, and only failures. A source whose last poll SUCCEEDED is not
  // broken however recently it failed — classifying on a leftover error string
  // kept recovered feeds in the broken list indefinitely.
  const broken = rows.filter((r) => (r.consecutiveFailures || 0) > 0);
  const quiet = rows.filter((r) => !((r.consecutiveFailures || 0) > 0));
  const ev = (m.events && m.events.byStatus) || {};
  const published = ev.PUBLISHED || 0;

  $('cards').innerHTML = [
    card('Storage', st.durability || '—', durCls),
    card('Boots', st.boots ?? '—'),
    card('Sources active', active, active > 0 ? 'ok' : 'dim'),
    card('Sources broken', broken.length, broken.length > 0 ? 'bad' : 'ok'),
    card('Sources quiet', quiet.length, 'dim'),
    card('Published (24h)', published, published > 0 ? 'ok' : 'dim'),
    card('Duplicates collapsed', (m.events && m.events.duplicatesTotal) || 0),
    card('Queue depth', (m.queue && m.queue.depth) || 0),
    card('Held as stale', (m.events && m.events.staleTotal) || 0),
  ].join('');

  $('broken').innerHTML = broken.length === 0
    ? '<div class="empty">Nothing is failing to fetch.</div>'
    : '<table><tr><th>Source</th><th>State</th><th>Fails</th><th>Reason</th></tr>' +
      broken.map((r) =>
        '<tr><td>' + esc(r.sourceId) + '</td>' +
        '<td class="' + (r.state === 'DISCONNECTED' ? 'bad' : 'warn') + '">' + esc(r.state) + '</td>' +
        '<td>' + esc(r.consecutiveFailures ?? 0) + '</td>' +
        '<td class="err">' + esc(r.lastError || 'no reason recorded') +
        '</td></tr>').join('') + '</table>';

  $('quiet').innerHTML = quiet.length === 0
    ? '<div class="empty">Every source has published recently.</div>'
    : '<table><tr><th>Source</th><th>State</th><th>Last item</th></tr>' +
      quiet.map((r) =>
        '<tr><td>' + esc(r.sourceId) + '</td>' +
        '<td class="dim">' + esc(r.state) + '</td>' +
        '<td class="dim">' + esc(r.lastItemAt || 'nothing yet') + '</td></tr>').join('') +
      '</table>';

  const dest = m.deliveriesByDestination || {};
  const destNames = Object.keys(dest);
  // A skip count with no reason next to it reads as a failure. Sprout is the
  // one that bites: it is an optional downstream, so on a deployment that never
  // set SPROUT_URL every single event is skipped, which looks alarming and is
  // in fact nothing at all.
  const whySkipped = (name, count) => {
    if (count === 0) return '';
    if (name === 'sprout') {
      return (m.sprout || {}).configured
        ? 'older than the freshness window'
        : 'SPROUT_URL not set — no downstream configured';
    }
    return 'held by the freshness window';
  };

  $('deliveries').innerHTML = destNames.length === 0
    ? '<div class="empty">Nothing delivered yet.</div>'
    : '<table><tr><th>Destination</th><th>Sent</th><th>Failed</th><th>Skipped</th><th>Why skipped</th></tr>' +
      destNames.map((name) => {
        const row = dest[name] || {};
        const failed = row.FAILED || 0;
        const skipped = row.SKIPPED || 0;
        return '<tr><td>' + esc(name) + '</td>' +
          '<td class="' + ((row.SENT || 0) > 0 ? 'ok' : 'dim') + '">' + esc(row.SENT || 0) + '</td>' +
          '<td class="' + (failed > 0 ? 'bad' : 'dim') + '">' + esc(failed) + '</td>' +
          '<td class="dim">' + esc(skipped) + '</td>' +
          '<td class="dim">' + esc(whySkipped(name, skipped)) + '</td></tr>';
      }).join('') + '</table>';

  // Plain-language gloss for the reasons an operator is most likely to ask
  // about. Anything unmapped still shows, under its own name.
  const REJECTION_MEANING = {
    NOISE_OLD_NEWS: 'published too long ago to be breaking — the freshness window',
    NO_IDENTIFIED_SUBJECT: 'a single-name story naming no company Scout could identify',
    NO_CATEGORY: 'not market news under any category',
    BELOW_THRESHOLD: 'classified, but scored under the publish threshold',
    FILING_IMMATERIAL: 'an SEC filing whose form and items are not material',
    DUPLICATE_EVENT: 'the same story, already published from another source',
    DUPLICATE_POST_ID: 'the identical post, seen twice',
    DUPLICATE_URL: 'the same link, already seen',
    DUPLICATE_TEXT: 'the same text, already seen',
  };

  const rej = (m.events && m.events.byRejection) || {};
  const rejNames = Object.keys(rej).sort((a, b) => (rej[b] || 0) - (rej[a] || 0));
  $('rejections').innerHTML = rejNames.length === 0
    ? '<div class="empty">Nothing dropped in this window.</div>'
    : '<table><tr><th>Reason</th><th>Count</th><th>What it means</th></tr>' +
      rejNames.map((name) =>
        '<tr><td>' + esc(name) + '</td>' +
        '<td class="dim">' + esc(rej[name] || 0) + '</td>' +
        '<td class="dim">' + esc(REJECTION_MEANING[name] || '') + '</td></tr>').join('') +
      '</table>';

  const d = m.discord || {}, w = m.webhook || {};
  const route = (name, on, detail) =>
    '<tr><td>' + esc(name) + '</td>' +
    '<td class="' + (on ? 'ok' : 'dim') + '">' + (on ? 'ready' : 'not configured') + '</td>' +
    '<td class="dim">' + esc(detail) + '</td></tr>';

  $('routes').innerHTML = '<table><tr><th>Route</th><th>State</th><th></th></tr>' +
    route('X / webhook', w.state !== 'NOT_CONFIGURED',
          'POST /webhook/news — ' + (w.eventsAcceptedTotal || 0) + ' accepted') +
    route('Discord intake channel', (d.intakeChannels || 0) > 0,
          (d.intakeChannels || 0) + ' channel(s) read by Scout\\'s own bot') +
    route('Discord bridge', !!d.webhookConfigured, 'POST /webhook/discord') +
    route('RSS / EDGAR', active > 0, active + ' feeds polling, no credential needed') +
    '</table>';
}

async function refresh() {
  try {
    const res = await fetch('/metrics', { cache: 'no-store' });
    render(await res.json());
  } catch (err) {
    $('cards').innerHTML = '<div class="empty bad">Could not read /metrics: ' + esc(err.message) + '</div>';
  }
}

$('token').value = localStorage.getItem('scoutAdminToken') || '';
$('token').addEventListener('change', (e) => localStorage.setItem('scoutAdminToken', e.target.value));

$('ingest').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submit'), out = $('result');
  const body = { url: $('url').value.trim() || null, text: $('text').value.trim() };
  if (!body.text && !body.url) { out.className = 'bad'; out.textContent = 'Give a URL, some text, or both.'; return; }

  btn.disabled = true;
  out.className = 'dim';
  out.textContent = 'sending…';
  try {
    const res = await fetch('/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + $('token').value },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    out.className = res.ok ? 'ok' : 'bad';
    out.textContent = res.ok
      ? 'accepted — ' + (data.id || '') + '\\nIt now goes through dedupe, classification and routing ' +
        'like any other event. If it does not reach a channel, that is the filters deciding, not a failure.'
      : (data.error || ('HTTP ' + res.status));
    if (res.ok) { $('url').value = ''; $('text').value = ''; }
  } catch (err) {
    out.className = 'bad';
    out.textContent = String(err);
  } finally {
    btn.disabled = false;
    setTimeout(refresh, 1500);
  }
});

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
