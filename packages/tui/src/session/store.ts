/**
 * Append-only JSONL session tree + SessionManager.
 *
 * Port of the Python harness's session/store.py + format.py. One node per turn, linked by
 * parentId, persisted as one JSON line per entry. File-backed or in-memory (--no-session).
 * A disk failure on append is logged-and-swallowed so it never kills a turn.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

export type EntryType = "user" | "assistant" | "tool" | "system" | "goal";

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: EntryType;
  ts: number;
  payload: Record<string, unknown>;
  label?: string | null;
}

/** A short, unique entry/session id (first 12 hex chars of uuid4). */
export function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function nowTs(): number {
  return Date.now() / 1000;
}

/** Compact relative age: just now / 5m ago / 2h ago / 3d ago / 5w ago. */
export function formatAge(ts: number, now: number = nowTs()): string {
  if (!ts || ts <= 0) return "?";
  const delta = Math.max(0, now - ts);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}d ago`;
  return `${Math.floor(delta / (86400 * 7))}w ago`;
}

export class SessionStore {
  private readonly path: string | null;
  private mem: SessionEntry[] = [];
  private tipId: string | null = null;
  displayName: string | null;
  readonly persistent: boolean;

  private constructor(path: string | null, displayName?: string | null) {
    this.path = path;
    this.persistent = path !== null;
    this.displayName = displayName ?? null;
  }

  static async fileBacked(path: string, displayName?: string | null): Promise<SessionStore> {
    const s = new SessionStore(path, displayName);
    await s.reload();
    return s;
  }

  static inMemory(): SessionStore {
    return new SessionStore(null);
  }

  get entries(): SessionEntry[] {
    return [...this.mem];
  }

  get tip(): string | null {
    return this.tipId;
  }

  /** Append one entry; returns it. Persists to disk best-effort (never throws). */
  async append(
    type: EntryType,
    payload: Record<string, unknown>,
    label?: string,
  ): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: newId(),
      parentId: this.tipId,
      type,
      ts: nowTs(),
      payload,
      label: label ?? null,
    };
    this.mem.push(entry);
    this.tipId = entry.id;
    if (this.path) {
      try {
        await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // disk failure must not kill the turn
      }
    }
    return entry;
  }

  /** Branch: continue the next append from `entryId` (must already exist). */
  setTip(entryId: string): void {
    if (!this.mem.some((e) => e.id === entryId)) throw new Error(`unknown entry id: ${entryId}`);
    this.tipId = entryId;
  }

  /** Root → entryId path (inclusive). Throws if unknown. */
  pathTo(entryId: string): SessionEntry[] {
    const byId = new Map(this.mem.map((e) => [e.id, e]));
    const target = byId.get(entryId);
    if (!target) throw new Error(`unknown entry id: ${entryId}`);
    const out: SessionEntry[] = [];
    let cur: string | null = entryId;
    while (cur !== null) {
      const e = byId.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentId;
    }
    return out.reverse();
  }

  /** parentId → child ids in insertion order (root key is null). */
  childrenMap(): Map<string | null, string[]> {
    const cm = new Map<string | null, string[]>();
    for (const e of this.mem) {
      const list = cm.get(e.parentId) ?? [];
      list.push(e.id);
      cm.set(e.parentId, list);
    }
    return cm;
  }

  /** Copy the root→fromEntryId path into a new session file. */
  async forkTo(dest: string, fromEntryId: string): Promise<SessionStore> {
    const path = this.pathTo(fromEntryId);
    await writeEntries(dest, path);
    return SessionStore.fileBacked(dest);
  }

  /** Copy the current branch (root→tip) into a new session file. */
  async cloneTo(dest: string): Promise<SessionStore> {
    if (this.tipId === null) {
      await writeEntries(dest, []);
      return SessionStore.fileBacked(dest);
    }
    return this.forkTo(dest, this.tipId);
  }

  private async reload(): Promise<void> {
    if (!this.path) return;
    try {
      const text = await readFile(this.path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          this.mem.push(JSON.parse(line) as SessionEntry);
        } catch {
          // one bad line must not lose the session
        }
      }
      this.tipId = this.mem.length ? this.mem[this.mem.length - 1]!.id : null;
    } catch {
      // missing file
    }
  }
}

async function writeEntries(dest: string, entries: SessionEntry[]): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(dest, entries.length ? `${body}\n` : "", "utf8");
}

export interface SessionSummary {
  sessionId: string;
  path: string;
  displayName: string | null;
  mtime: number;
  nEntries: number;
  created: number;
}

/** Discovers/creates session files under `<base>/<cwd-slug>/<uuid>.jsonl`. */
export class SessionManager {
  private readonly base: string;
  constructor(base?: string) {
    this.base = base ?? join(homedir(), ".minima-harness", "sessions");
  }

  slugFor(directory: string): string {
    const resolved = resolvePath(directory);
    return resolved.replace(/[/\\]/g, "-").replace(/^-+/, "") || "root";
  }

  private async dirFor(directory: string): Promise<string> {
    const d = join(this.base, this.slugFor(directory));
    await mkdir(d, { recursive: true });
    return d;
  }

  async new(directory: string, name?: string): Promise<SessionStore> {
    const sid = newId();
    const path = join(await this.dirFor(directory), `${sid}.jsonl`);
    return SessionStore.fileBacked(path, name ?? null);
  }

  async open(
    directory: string,
    opts: { sessionId?: string; noSession?: boolean } = {},
  ): Promise<SessionStore> {
    if (opts.noSession) return SessionStore.inMemory();
    if (opts.sessionId) {
      const sessions = await this.listSessions(directory);
      for (const s of sessions) {
        if (s.sessionId.startsWith(opts.sessionId) || opts.sessionId.startsWith(s.sessionId)) {
          return SessionStore.fileBacked(s.path, s.displayName);
        }
      }
      throw new Error(`no session matching id: ${opts.sessionId}`);
    }
    const recent = await this.mostRecent(directory);
    if (recent) return SessionStore.fileBacked(recent.path, recent.displayName);
    return this.new(directory);
  }

  async mostRecent(directory: string): Promise<SessionSummary | null> {
    const sessions = await this.listSessions(directory);
    return sessions.reduce<SessionSummary | null>(
      (acc, s) => (acc === null || s.mtime > acc.mtime ? s : acc),
      null,
    );
  }

  async listSessions(directory: string): Promise<SessionSummary[]> {
    const d = join(this.base, this.slugFor(directory));
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
      const p = join(d, name);
      try {
        const text = await readFile(p, "utf8");
        const nonempty = text.split(/\r?\n/).filter((l) => l.trim());
        const st = await stat(p);
        out.push({
          sessionId: basename(name, ".jsonl"),
          path: p,
          displayName: firstUserText(nonempty),
          mtime: st.mtimeMs / 1000,
          nEntries: nonempty.length,
          created: firstEntryTs(nonempty) ?? st.mtimeMs / 1000,
        });
      } catch {
        // skip unreadable
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime); // most-recently-used first
  }
}

function firstEntryTs(lines: string[]): number | null {
  if (!lines.length) return null;
  try {
    const obj = JSON.parse(lines[0]!) as { ts?: unknown };
    return typeof obj.ts === "number" ? obj.ts : null;
  } catch {
    return null;
  }
}

function firstUserText(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: unknown; payload?: { text?: unknown } };
      if (obj.type !== "user") continue;
      const text = obj.payload?.text;
      if (typeof text !== "string") continue;
      const firstLine = text.split(/\r?\n/).find((l) => l.trim());
      if (!firstLine) continue;
      const name = firstLine.trim().replace(/\s+/g, " ").slice(0, 48);
      if (name) return name;
    } catch {
      // skip unparseable line
    }
  }
  return null;
}
