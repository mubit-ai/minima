/** Readonly helpers over the harness SQLite DB (~/.minima-harness/minima.db shape). */

import { Database } from "bun:sqlite";

export interface RunRow {
  run_id: string;
  status: string;
  parent_run_id: string | null;
  project_key: string;
}

export interface DecisionRow {
  rec_id: string;
  run_id: string;
  agent_id: string; // "" = lead agent; sub-agents carry their child id
  chosen_model: string;
  decision_basis: string;
  routed: string; // server | pinned | offline
  task_type: string;
  difficulty: string;
  est_cost_usd: number | null;
  all_premium_cost_usd: number | null;
  actual_cost_usd: number | null;
  outcome: string | null;
  judged: number;
  ranked: string | null;
}

export class HarnessDb {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }
  close(): void {
    this.db.close();
  }

  runs(): RunRow[] {
    return this.db
      .query("SELECT run_id, status, parent_run_id, project_key FROM runs ORDER BY created")
      .all() as RunRow[];
  }
  latestRun(): RunRow | null {
    return (this.db
      .query("SELECT run_id, status, parent_run_id, project_key FROM runs ORDER BY created DESC LIMIT 1")
      .get() ?? null) as RunRow | null;
  }
  decisions(runId?: string): DecisionRow[] {
    const sql =
      "SELECT rec_id, run_id, agent_id, chosen_model, decision_basis, routed, task_type, difficulty, est_cost_usd, all_premium_cost_usd, actual_cost_usd, outcome, judged, ranked FROM routing_decisions" +
      (runId ? " WHERE run_id = ?" : "") +
      " ORDER BY ts";
    return (runId ? this.db.query(sql).all(runId) : this.db.query(sql).all()) as DecisionRow[];
  }
  budget(scopeKey?: string): Record<string, unknown> | null {
    const sql = scopeKey
      ? "SELECT * FROM budgets WHERE scope_key = ?"
      : "SELECT * FROM budgets ORDER BY updated DESC LIMIT 1";
    return (scopeKey ? this.db.query(sql).get(scopeKey) : this.db.query(sql).get()) as Record<
      string,
      unknown
    > | null;
  }
  budgetEventKinds(): string[] {
    return (this.db.query("SELECT kind FROM budget_events ORDER BY rowid").all() as { kind: string }[]).map(
      (r) => r.kind,
    );
  }
  toolCallCount(runId?: string): number {
    const sql = "SELECT COUNT(*) AS n FROM tool_calls" + (runId ? " WHERE run_id = ?" : "");
    const row = (runId ? this.db.query(sql).get(runId) : this.db.query(sql).get()) as { n: number };
    return row.n;
  }
}
