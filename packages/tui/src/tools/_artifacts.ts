/**
 * Artifact spill store (P1) — the model-visible spill tier behind the _bounds SpillSink.
 * Truncated tool output is content-addressed to <dir>/<sha256>.txt (sibling of the DB,
 * like the v13 blobs/ tier) and indexed in SQLite via a late-bound ArtifactIndex; the
 * truncation notice carries the absolute path so the model pages it back via read.
 * Every operation is fail-open: any error means no ref, never a broken tool result.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileSink } from "bun";
import type { SpillSink } from "./_bounds.ts";
import type { ArtifactStream, ToolArtifacts } from "./types.ts";

/** Structural index seam — the store never imports MinimaDb (db-layer style). */
export interface ArtifactIndex {
  recordArtifact(r: {
    sha: string;
    path: string;
    runId: string | null;
    toolName: string;
    bytes: number;
    lineCount: number;
  }): void;
}

function lineCountOf(chars: number, newlines: number, endsWithNewline: boolean): number {
  if (chars === 0) return 0;
  return endsWithNewline ? newlines : newlines + 1;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n += 1;
  return n;
}

class ArtifactFileStream implements ArtifactStream {
  private readonly file: FileSink;
  private readonly tmpPath: string;
  private readonly dir: string;
  private readonly record: (sha: string, path: string, bytes: number, lineCount: number) => void;
  private readonly hasher = new Bun.CryptoHasher("sha256");
  private bytes = 0;
  private chars = 0;
  private newlines = 0;
  private endsWithNewline = false;
  private failed = false;
  private settled = false;

  constructor(
    file: FileSink,
    tmpPath: string,
    dir: string,
    record: (sha: string, path: string, bytes: number, lineCount: number) => void,
  ) {
    this.file = file;
    this.tmpPath = tmpPath;
    this.dir = dir;
    this.record = record;
  }

  write(chunk: string): void {
    if (this.failed || this.settled || !chunk) return;
    try {
      this.hasher.update(chunk);
      this.file.write(chunk);
      this.bytes += Buffer.byteLength(chunk, "utf8");
      this.chars += chunk.length;
      this.newlines += countNewlines(chunk);
      this.endsWithNewline = chunk.endsWith("\n");
    } catch {
      this.failed = true;
    }
  }

  async commit(): Promise<{ ref: string } | null> {
    if (this.settled) return null;
    this.settled = true;
    if (this.failed) {
      await this.cleanup();
      return null;
    }
    try {
      await this.file.end();
      const sha = this.hasher.digest("hex");
      const target = join(this.dir, `${sha}.txt`);
      if (existsSync(target)) rmSync(this.tmpPath, { force: true });
      else renameSync(this.tmpPath, target);
      this.record(
        sha,
        target,
        this.bytes,
        lineCountOf(this.chars, this.newlines, this.endsWithNewline),
      );
      return { ref: target };
    } catch {
      await this.cleanup();
      return null;
    }
  }

  async discard(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.file.end();
    } catch {
      // sink already closed or never opened
    }
    try {
      rmSync(this.tmpPath, { force: true });
    } catch {
      // best-effort tmp removal
    }
  }
}

export class ArtifactStore implements ToolArtifacts {
  readonly dir: string;
  private index: ArtifactIndex | null = null;
  private runId: string | null = null;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  /** Late-bound like main.ts's bookSearchFee — tools are built before the DB opens. */
  attach(index: ArtifactIndex, runId: string): void {
    this.index = index;
    this.runId = runId;
  }

  sink(tool: string): SpillSink {
    return (full: string) => {
      try {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(full);
        const sha = hasher.digest("hex");
        mkdirSync(this.dir, { recursive: true });
        const path = join(this.dir, `${sha}.txt`);
        if (!existsSync(path)) writeFileSync(path, full, "utf8");
        this.recordRow(
          tool,
          sha,
          path,
          Buffer.byteLength(full, "utf8"),
          lineCountOf(full.length, countNewlines(full), full.endsWith("\n")),
        );
        return { ref: path };
      } catch {
        return null;
      }
    };
  }

  beginStream(tool: string): ArtifactStream | null {
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `tmp-${crypto.randomUUID().slice(0, 8)}.part`);
      return new ArtifactFileStream(
        Bun.file(tmp).writer(),
        tmp,
        this.dir,
        (sha, path, bytes, lineCount) => this.recordRow(tool, sha, path, bytes, lineCount),
      );
    } catch {
      return null;
    }
  }

  private recordRow(
    tool: string,
    sha: string,
    path: string,
    bytes: number,
    lineCount: number,
  ): void {
    try {
      this.index?.recordArtifact({
        sha,
        path,
        runId: this.runId,
        toolName: tool,
        bytes,
        lineCount,
      });
    } catch {
      // index failure never blocks the spill — the file stands on its own
    }
  }
}
