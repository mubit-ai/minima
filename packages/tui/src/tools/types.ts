import type { SpillSink } from "./_bounds.ts";

/** Incremental artifact writer for streaming tools (bash tee): chunks pushed into the
 * bounded buffer are teed here in push order; commit() lands the content-addressed file,
 * discard() drops it. Every operation is fail-open — a broken stream never affects the
 * command result. */
export interface ArtifactStream {
  write(chunk: string): void;
  commit(): Promise<{ ref: string } | null>;
  discard(): Promise<void>;
}

/** Artifact spill store surface threaded into tools (P1). `sink(tool)` feeds boundText's
 * SpillSink for whole-string spills (grep/glob/ls); `beginStream(tool)` opens the bash
 * tee; `dir` is the one extra root read's confinement allowance opens toward. */
export interface ToolArtifacts {
  dir: string;
  sink(tool: string): SpillSink;
  beginStream(tool: string): ArtifactStream | null;
}

/** Shared options for filesystem tool factories. */
export interface FsToolOptions {
  /**
   * Optional base directory for this tool instance. Relative paths resolve against it and
   * resolved targets outside it are rejected (see _io.resolveWithin) — the isolation
   * contract for per-sub-agent tool sets. Omit for the historical behavior (ambient cwd).
   */
  workdir?: string;
  /**
   * Artifact spill store (P1). Absent = feature off: no spill refs, no artifact writes,
   * and read's confinement allowance stays closed.
   */
  artifacts?: ToolArtifacts;
}
