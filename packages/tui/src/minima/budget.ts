/**
 * BudgetLedger — client-side budget following (the server's cost cap is a SOFT filter;
 * hard enforcement lives here, next to the running-spend state).
 *
 * Reserve → run → reconcile: before a routed run we reserve a multiplier over the
 * server's est_cost_high (it's a p75 — it under-covers by construction), after the run we
 * reconcile with realized cost. State is DB-backed per scope: reserve/reconcile execute a
 * guarded UPDATE inside a single-writer transaction, so two concurrent sessions sharing a
 * scope can never jointly overshoot. Graduated interventions (fire once per threshold):
 *   50% notice → 75% warn → 90% strong warn → 100% wrap-up-then-stop (enforce mode).
 * Modes stage the rollout: shadow (track only) → warn (never blocks) → enforce.
 */

import type { MinimaDb } from "../db/minima_db.ts";
import { newId } from "../db/minima_db.ts";

export type BudgetMode = "shadow" | "warn" | "enforce";

export interface BudgetStatus {
  scopeKey: string;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  fraction: number;
  mode: BudgetMode;
}

export interface BudgetEvent {
  kind: "reserve" | "reconcile" | "release" | "threshold" | "deny";
  scopeKey: string;
  amountUsd?: number;
  note?: string;
  status: BudgetStatus;
}

/** How much to reserve for a run given the server's estimate band. */
export function reserveAmount(estCostUsd: number, estCostHigh: number | null): number {
  // est_cost_high is a p75 — pad it; with no band, pad the point estimate harder.
  const RESERVE_MULTIPLIER = 1.5;
  const NO_BAND_MULTIPLIER = 3;
  return estCostHigh !== null
    ? estCostHigh * RESERVE_MULTIPLIER
    : Math.max(estCostUsd * NO_BAND_MULTIPLIER, 0.0001);
}

const THRESHOLDS = [0.5, 0.75, 0.9, 1.0] as const;

export class BudgetLedger {
  readonly scopeKey: string;
  private readonly db: MinimaDb;
  private onEvent: ((e: BudgetEvent) => void) | null;
  private readonly runId: string | null;
  /** Thresholds already announced (fire each once per ledger instance). */
  private fired = new Set<number>();
  private reservations = new Map<string, number>();

  constructor(opts: {
    db: MinimaDb;
    scopeKey: string;
    limitUsd: number;
    mode?: BudgetMode;
    runId?: string | null;
    onEvent?: (e: BudgetEvent) => void;
  }) {
    this.db = opts.db;
    this.scopeKey = opts.scopeKey;
    this.runId = opts.runId ?? null;
    this.onEvent = opts.onEvent ?? null;
    const now = Date.now() / 1000;
    // Create the scope if absent; an existing scope keeps its accumulated state but the
    // limit/mode may be re-set explicitly by the caller (a user typing /budget set).
    this.db.db.run(
      `INSERT INTO budgets (scope_key, limit_usd, mode, created, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET limit_usd = excluded.limit_usd, mode = excluded.mode, updated = excluded.updated`,
      [opts.scopeKey, opts.limitUsd, opts.mode ?? "warn", now, now],
    );
  }

  status(): BudgetStatus {
    const row = this.db.db
      .query("SELECT limit_usd, spent_usd, reserved_usd, mode FROM budgets WHERE scope_key = ?")
      .get(this.scopeKey) as {
      limit_usd: number;
      spent_usd: number;
      reserved_usd: number;
      mode: BudgetMode;
    };
    const remaining = Math.max(0, row.limit_usd - row.spent_usd - row.reserved_usd);
    return {
      scopeKey: this.scopeKey,
      limitUsd: row.limit_usd,
      spentUsd: row.spent_usd,
      reservedUsd: row.reserved_usd,
      remainingUsd: remaining,
      fraction: row.limit_usd > 0 ? (row.spent_usd + row.reserved_usd) / row.limit_usd : 1,
      mode: row.mode,
    };
  }

  get mode(): BudgetMode {
    return this.status().mode;
  }

  /** Re-target event delivery (stderr in headless modes, chat notices in the TUI). */
  setOnEvent(fn: ((e: BudgetEvent) => void) | null): void {
    this.onEvent = fn;
  }

  setMode(mode: BudgetMode): void {
    this.db.db.run("UPDATE budgets SET mode = ?, updated = ? WHERE scope_key = ?", [
      mode,
      Date.now() / 1000,
      this.scopeKey,
    ]);
  }

  /**
   * Atomically reserve `amountUsd` — succeeds only if it fits under the limit RIGHT NOW
   * (guarded UPDATE inside a single-writer transaction: cross-process safe). In
   * shadow/warn modes an over-limit reserve is granted anyway (never blocks) but the
   * event stream shows it; in enforce mode it is denied.
   */
  reserve(
    amountUsd: number,
    note?: string,
  ): { ok: true; id: string } | { ok: false; reason: string } {
    const id = newId();
    let granted = false;
    const tx = this.db.db.transaction(() => {
      const changed = this.db.db.run(
        `UPDATE budgets SET reserved_usd = reserved_usd + ?1, updated = ?2
         WHERE scope_key = ?3 AND (mode != 'enforce' OR spent_usd + reserved_usd + ?1 <= limit_usd)`,
        [amountUsd, Date.now() / 1000, this.scopeKey],
      );
      granted = changed.changes > 0;
      this.logEvent(granted ? "reserve" : "deny", amountUsd, note);
    });
    tx.immediate(); // BEGIN IMMEDIATE — take the write lock up front
    if (!granted) {
      this.emit("deny", amountUsd, note);
      const s = this.status();
      return {
        ok: false,
        reason: `budget: reserving $${amountUsd.toFixed(4)} would exceed the $${s.limitUsd.toFixed(2)} limit (spent $${s.spentUsd.toFixed(4)}, reserved $${s.reservedUsd.toFixed(4)})`,
      };
    }
    this.reservations.set(id, amountUsd);
    this.emit("reserve", amountUsd, note);
    this.checkThresholds();
    return { ok: true, id };
  }

  /** Swap a reservation for the realized cost (release the hold, book the actual). */
  reconcile(id: string, actualUsd: number, recId?: string | null): void {
    const held = this.reservations.get(id) ?? 0;
    this.reservations.delete(id);
    const tx = this.db.db.transaction(() => {
      this.db.db.run(
        "UPDATE budgets SET reserved_usd = MAX(0, reserved_usd - ?), spent_usd = spent_usd + ?, updated = ? WHERE scope_key = ?",
        [held, actualUsd, Date.now() / 1000, this.scopeKey],
      );
      this.logEvent("reconcile", actualUsd, recId ?? undefined);
    });
    tx.immediate();
    this.emit("reconcile", actualUsd);
    this.checkThresholds();
  }

  /** Drop a reservation without booking spend (run never happened). */
  release(id: string): void {
    const held = this.reservations.get(id);
    if (held === undefined) return;
    this.reservations.delete(id);
    const tx = this.db.db.transaction(() => {
      this.db.db.run(
        "UPDATE budgets SET reserved_usd = MAX(0, reserved_usd - ?), updated = ? WHERE scope_key = ?",
        [held, Date.now() / 1000, this.scopeKey],
      );
      this.logEvent("release", held);
    });
    tx.immediate();
    this.emit("release", held);
  }

  /** Remaining head-room to thread into recommend() as max_cost_per_call. */
  maxCostPerCall(): number | undefined {
    const s = this.status();
    if (s.mode === "shadow") return undefined; // shadow never changes routing
    return s.remainingUsd > 0 ? s.remainingUsd : undefined;
  }

  /** True once spend has hit the limit (the wrap-up/stop signal for enforce mode). */
  exhausted(): boolean {
    const s = this.status();
    return s.spentUsd >= s.limitUsd;
  }

  private checkThresholds(): void {
    const s = this.status();
    const usedFraction = s.limitUsd > 0 ? s.spentUsd / s.limitUsd : 1;
    for (const t of THRESHOLDS) {
      if (usedFraction >= t && !this.fired.has(t)) {
        this.fired.add(t);
        const note =
          t >= 1
            ? s.mode === "enforce"
              ? "budget exhausted — wrapping up, further runs will be refused"
              : "budget exhausted (warn mode — runs continue; /budget mode enforce to stop)"
            : `budget ${Math.round(t * 100)}% used ($${s.spentUsd.toFixed(4)} of $${s.limitUsd.toFixed(2)})`;
        this.logEventSafe("threshold", s.spentUsd, note);
        this.onEvent?.({ kind: "threshold", scopeKey: this.scopeKey, note, status: s });
      }
    }
  }

  private emit(kind: BudgetEvent["kind"], amountUsd?: number, note?: string): void {
    this.onEvent?.({ kind, scopeKey: this.scopeKey, amountUsd, note, status: this.status() });
  }

  /** Append a budget_events row (call inside a transaction). */
  private logEvent(kind: string, amountUsd?: number, note?: string): void {
    const s = this.db.db
      .query("SELECT limit_usd, spent_usd, reserved_usd FROM budgets WHERE scope_key = ?")
      .get(this.scopeKey) as { limit_usd: number; spent_usd: number; reserved_usd: number };
    this.db.db.run(
      `INSERT INTO budget_events (id, scope_key, run_id, rec_id, kind, amount_usd, spent_usd, reserved_usd, limit_usd, note, ts)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        this.scopeKey,
        this.runId,
        kind,
        amountUsd ?? null,
        s.spent_usd,
        s.reserved_usd,
        s.limit_usd,
        note ?? null,
        Date.now() / 1000,
      ],
    );
  }

  private logEventSafe(kind: string, amountUsd?: number, note?: string): void {
    try {
      this.logEvent(kind, amountUsd, note);
    } catch {
      // budget telemetry must never break a run
    }
  }
}
