#!/usr/bin/env bash
#
# End-to-end smoke test against a RUNNING Scout process.
#
# Exercises the surfaces a deployment actually depends on — the health endpoints,
# both webhook paths, their authentication boundary, the admin endpoint and the
# secret-safety of /metrics — over real HTTP, against a real process, with a real
# database. Unit tests prove the pieces; this proves they are wired together.
#
#   npm run build && npm start &          # or point it at a deployed instance
#   npm run smoke
#
# Configuration, all optional except SMOKE_BASE when not local:
#
#   SMOKE_BASE              default http://127.0.0.1:$PORT (or :10000)
#   SCOUT_WEBHOOK_TOKEN     enables the X webhook checks
#   DISCORD_INTEL_TOKEN     enables the Discord webhook checks
#   SCOUT_ADMIN_TOKEN       enables the admin checks
#
# A check whose token is unset is SKIPPED, not failed — running without the
# optional endpoints is a supported configuration.
#
# Exits non-zero if any check fails, so it works in CI.

set -uo pipefail

BASE="${SMOKE_BASE:-http://127.0.0.1:${PORT:-10000}}"
BODY="$(mktemp)"
METRICS="$(mktemp)"
trap 'rm -f "$BODY" "$METRICS"' EXIT

pass=0
fail=0
skip=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  \033[32mok\033[0m    %-48s %s\n' "$name" "$actual"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-48s expected=%s got=%s\n' "$name" "$expected" "$actual"
    printf '        body: %s\n' "$(head -c 300 "$BODY")"
    fail=$((fail + 1))
  fi
}

skipped() {
  printf '  \033[33mskip\033[0m  %-48s %s\n' "$1" "$2"
  skip=$((skip + 1))
}

code() { curl -s -o "$BODY" -w '%{http_code}' --max-time 20 "$@"; }

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Unique per run, so re-running does not simply report duplicates.
STAMP="$(date -u +%s)"

echo "smoke: $BASE"
echo
echo "── health surface ────────────────────────────────────────────────────"
check "GET /health"  200 "$(code "$BASE/health")"
check "GET /metrics" 200 "$(code "$BASE/metrics")"
check "unknown path is 404" 404 "$(code "$BASE/definitely-not-a-route")"

# /ready is deliberately NOT asserted 200. It reports 503 when input channels
# are configured but the Discord gateway is down, which is correct — and is the
# normal state anywhere the gateway is unreachable.
printf '  \033[36minfo\033[0m  %-48s %s\n' "GET /ready" "$(code "$BASE/ready")"

echo
echo "── X webhook ─────────────────────────────────────────────────────────"
if [ -z "${SCOUT_WEBHOOK_TOKEN:-}" ]; then
  skipped "X webhook" "SCOUT_WEBHOOK_TOKEN unset"
else
  check "rejects a missing token" 401 \
    "$(code -X POST "$BASE/webhook/news" -H 'Content-Type: application/json' -d '{}')"
  check "rejects a wrong token" 401 \
    "$(code -X POST "$BASE/webhook/news" -H 'Authorization: Bearer definitely-wrong' \
       -H 'Content-Type: application/json' -d '{}')"
  check "rejects a malformed body" 400 \
    "$(code -X POST "$BASE/webhook/news" -H "Authorization: Bearer $SCOUT_WEBHOOK_TOKEN" \
       -H 'Content-Type: application/json' -d '{"nope":1}')"

  X_BODY="{\"v\":1,\"platform\":\"x\",\"id\":\"smoke-x-$STAMP\",\"url\":\"https://x.com/DeItaone/status/$STAMP\",\"source\":\"Walter Bloomberg\",\"handle\":\"DeItaone\",\"text\":\"US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED\",\"published_at\":\"$NOW\"}"

  check "accepts a market-moving post" 202 \
    "$(code -X POST "$BASE/webhook/news" -H "Authorization: Bearer $SCOUT_WEBHOOK_TOKEN" \
       -H 'Content-Type: application/json' -d "$X_BODY")"
  # Idempotency: the SAME post again is acknowledged, not double-published.
  check "is idempotent on a repeat" 200 \
    "$(code -X POST "$BASE/webhook/news" -H "Authorization: Bearer $SCOUT_WEBHOOK_TOKEN" \
       -H 'Content-Type: application/json' -d "$X_BODY")"
fi

echo
echo "── Discord webhook ───────────────────────────────────────────────────"
if [ -z "${DISCORD_INTEL_TOKEN:-}" ]; then
  skipped "Discord webhook" "DISCORD_INTEL_TOKEN unset"
else
  check "rejects a missing token" 401 \
    "$(code -X POST "$BASE/webhook/discord" -H 'Content-Type: application/json' -d '{}')"
  # The two ingestion secrets are separate on purpose: the X relay operator must
  # not be able to push into the Discord source, or vice versa.
  if [ -n "${SCOUT_WEBHOOK_TOKEN:-}" ]; then
    check "the X token cannot push here" 401 \
      "$(code -X POST "$BASE/webhook/discord" -H "Authorization: Bearer $SCOUT_WEBHOOK_TOKEN" \
         -H 'Content-Type: application/json' -d '{}')"
  fi
  check "rejects an unconfigured channel" 200 \
    "$(code -X POST "$BASE/webhook/discord" -H "Authorization: Bearer $DISCORD_INTEL_TOKEN" \
       -H 'Content-Type: application/json' \
       -d "{\"v\":1,\"message_id\":\"smoke-d-reject-$STAMP\",\"channel_id\":\"999999999999999999\",\"author_name\":\"nobody\",\"content\":\"should not be ingested\",\"timestamp\":\"$NOW\"}")"
  grep -q '"accepted": *false' "$BODY" \
    && printf '  \033[32mok\033[0m    %-48s %s\n' "…and reports it as not accepted" "accepted=false" \
    || { printf '  \033[31mFAIL\033[0m  %-48s\n' "…and reports it as not accepted"; fail=$((fail + 1)); }
fi

echo
echo "── admin ─────────────────────────────────────────────────────────────"
if [ -z "${SCOUT_ADMIN_TOKEN:-}" ]; then
  skipped "admin replay" "SCOUT_ADMIN_TOKEN unset (endpoint disabled)"
else
  check "rejects a missing token" 401 "$(code -X POST "$BASE/admin/replay")"
  check "runs with the admin token" 200 \
    "$(code -X POST "$BASE/admin/replay" -H "Authorization: Bearer $SCOUT_ADMIN_TOKEN")"
fi

echo
echo "── /metrics carries no secret ────────────────────────────────────────"
curl -s --max-time 20 "$BASE/metrics" > "$METRICS"
leaked=0
for secret in "${SCOUT_WEBHOOK_TOKEN:-}" "${DISCORD_INTEL_TOKEN:-}" "${SCOUT_ADMIN_TOKEN:-}" \
              "${DISCORD_BOT_TOKEN:-}" "${X_BEARER_TOKEN:-}" "${SPROUT_TOKEN:-}"; do
  [ -z "$secret" ] && continue
  if grep -qF -- "$secret" "$METRICS"; then
    printf '  \033[31mFAIL\033[0m  a configured secret appears in /metrics\n'
    leaked=1
  fi
done
if [ "$leaked" -eq 0 ]; then
  printf '  \033[32mok\033[0m    %-48s\n' "no configured secret appears in /metrics"
  pass=$((pass + 1))
else
  fail=$((fail + 1))
fi

echo
echo "── what the pipeline did ─────────────────────────────────────────────"
python3 - "$METRICS" <<'PY' 2>/dev/null || echo "  (python3 unavailable; skipping summary)"
import json, sys
m = json.load(open(sys.argv[1]))
def show(path, label):
    node = m
    for part in path.split('.'):
        node = (node or {}).get(part) if isinstance(node, dict) else None
    print(f"  {label:24} {json.dumps(node)}")
show('events.byStatus', 'events by status')
show('queue', 'queue')
show('deliveriesByDestination', 'deliveries by channel')
show('storage.durability', 'storage durability')
show('storage.boots', 'storage boots')
show('sources.byState', 'sources by state')
PY

echo
printf 'smoke: %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || exit 1
