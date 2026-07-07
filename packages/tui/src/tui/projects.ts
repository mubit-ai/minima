/**
 * Per-repo Minima project map — `~/.minima-harness/projects.json` (0600).
 *
 * `minima auth` provisions one Mubit project per repo (all under a single
 * per-user instance) and records the mapping here so routing can isolate memory
 * by repo via HarnessConfig.namespace. Keyed by a stable repo identity (git
 * origin URL when available, else the repo root / cwd path).
 */

import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const GLOBAL_DIR_DEFAULT = join(homedir(), ".minima-harness");
let globalDir = GLOBAL_DIR_DEFAULT;

/** Override the config directory (tests). */
export function setProjectsDir(dir: string): void {
  globalDir = dir;
}

const projectsPath = () => join(globalDir, "projects.json");

export interface ProjectMapping {
  instanceId: string;
  projectId: string;
  namespace: string;
  minimaUrl: string;
}

async function readAll(): Promise<Record<string, ProjectMapping>> {
  try {
    const text = await readFile(projectsPath(), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, ProjectMapping>;
  } catch {
    // missing / unreadable / malformed → empty map
  }
  return {};
}

async function writeAll(data: Record<string, ProjectMapping>): Promise<void> {
  await mkdir(globalDir, { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  // O_CREAT 0600 so the file is owner-only from the moment it exists.
  const handle = await open(projectsPath(), "w", 0o600);
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await chmod(projectsPath(), 0o600);
  } catch {
    // best-effort
  }
}

export async function getProject(repo: string): Promise<ProjectMapping | null> {
  return (await readAll())[repo] ?? null;
}

export async function setProject(repo: string, mapping: ProjectMapping): Promise<void> {
  const data = await readAll();
  data[repo] = mapping;
  await writeAll(data);
}

/**
 * Stable identity for the repo at `cwd`: the normalized git origin URL when the
 * directory is a git repo with a remote, else the repo root path, else `cwd`.
 * Used both as the projects.json key and as the project name sent to the console.
 */
export function repoIdentity(cwd: string): string {
  const git = (args: string[]): string | null => {
    try {
      const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
      if (r.exitCode !== 0) return null;
      const out = r.stdout.toString().trim();
      return out || null;
    } catch {
      return null;
    }
  };

  const origin = git(["remote", "get-url", "origin"]);
  if (origin) {
    // git@github.com:org/repo.git  and  https://github.com/org/repo.git  ->  github.com/org/repo
    return origin
      .replace(/^git@/, "")
      .replace(/^ssh:\/\//, "")
      .replace(/^https?:\/\//, "")
      .replace(/:/, "/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  }
  return git(["rev-parse", "--show-toplevel"]) ?? cwd;
}
