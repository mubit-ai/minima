/** Shared options for filesystem tool factories. */
export interface FsToolOptions {
  /**
   * Optional base directory for this tool instance. Relative paths resolve against it and
   * resolved targets outside it are rejected (see _io.resolveWithin) — the isolation
   * contract for per-sub-agent tool sets. Omit for the historical behavior (ambient cwd).
   */
  workdir?: string;
}
