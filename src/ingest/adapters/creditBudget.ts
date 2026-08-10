import type { ScoutDb } from '../../db/index.js';

/**
 * A daily spend cap for a metered API, counted in the unit the vendor bills.
 *
 * Scrape Creators bills PER POST RETURNED, not per request, and that distinction
 * decides whether this integration is viable at all. A request is one HTTP call;
 * a request that returns a page of twenty posts costs twenty credits. Polling
 * three accounts every thirty seconds at a page size of five is 1,800 credits an
 * hour — so a hundred-credit balance is not a small budget, it is about ten
 * minutes of runtime.
 *
 * Counting requests here would have reported that budget as barely touched
 * while the balance emptied. The unit has to match the invoice.
 *
 * ── RESERVE, THEN SETTLE ─────────────────────────────────────────────────────
 *
 * The cost of a call is not known until the response arrives, but the decision
 * to spend has to be made before it. So a caller reserves the worst case (the
 * page size it asked for), and settles afterwards against what actually came
 * back, releasing the difference.
 *
 * A crash between the two leaves the full reservation spent. That is the
 * intended bias: over-counting costs accuracy, under-counting costs money.
 *
 * ── WHY THE COUNTER IS PERSISTED ─────────────────────────────────────────────
 *
 * An in-process counter resets on restart, and Scout restarts on every deploy,
 * every crash and every platform-initiated container move. A budget that resets
 * on restart is not a budget: a redeploy loop would spend the entire balance in
 * minutes while reporting that it had barely started. The count lives in
 * `runtime_state` for the same reason the priming flag does.
 *
 * Keyed by UTC day, which is the unit vendors reset on.
 */

const KEY_PREFIX = 'credits:';

export interface CreditBudget {
  /**
   * Reserves `units` credits up front. False means the cap would be exceeded
   * and the caller must not make the call — checked BEFORE spending, never
   * after.
   */
  tryReserve(units: number): boolean;
  /**
   * Reconciles a reservation against what the call actually cost, releasing any
   * difference. Never increases the total beyond the reservation.
   */
  settle(reserved: number, actual: number): void;
  /** Credits consumed today. */
  spent(): number;
  /** Credits still available today. */
  remaining(): number;
  /** The cap itself, so callers can report the runway. */
  limit: number;
}

export interface CreditBudgetDeps {
  db: ScoutDb;
  /** Names the meter, so two vendors do not share a counter. */
  vendor: string;
  /** Credits permitted per UTC day. */
  limit: number;
  now?: () => Date;
}

/** `2026-08-10T17:04:00Z` → `2026-08-10`. */
export function utcDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function createCreditBudget(deps: CreditBudgetDeps): CreditBudget {
  const now = deps.now ?? (() => new Date());
  const read = deps.db.raw.prepare('SELECT value FROM runtime_state WHERE key = ?');
  const write = deps.db.raw.prepare(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  const keyFor = (at: Date): string => `${KEY_PREFIX}${deps.vendor}:${utcDayOf(at)}`;

  function spentAt(at: Date): number {
    const row = read.get(keyFor(at)) as { value?: string } | undefined;
    const parsed = Number.parseInt(row?.value ?? '0', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function setAt(at: Date, value: number): void {
    write.run(keyFor(at), String(Math.max(0, value)), at.toISOString());
  }

  return {
    limit: deps.limit,

    spent(): number {
      return spentAt(now());
    },

    remaining(): number {
      return Math.max(0, deps.limit - spentAt(now()));
    },

    tryReserve(units: number): boolean {
      const cost = Math.max(1, Math.ceil(units));
      const at = now();
      const used = spentAt(at);
      if (used + cost > deps.limit) return false;

      setAt(at, used + cost);
      return true;
    },

    settle(reserved: number, actual: number): void {
      const refund = Math.max(0, Math.ceil(reserved) - Math.max(0, Math.ceil(actual)));
      if (refund === 0) return;
      const at = now();
      setAt(at, spentAt(at) - refund);
    },
  };
}
