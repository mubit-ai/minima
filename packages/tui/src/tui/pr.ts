/**
 * /pr — cut a branch, commit what's dirty, push, open a PR against the chosen base.
 *
 * The branch is cut from current HEAD, so commits the working branch already has ahead of
 * the base come along for free; the dirty worktree becomes one final commit on top. Branch
 * name, commit message and PR title/body come from one cheap completion over the diff, with
 * a deterministic fallback when the model is unavailable or replies with junk.
 *
 * Push and PR creation are outward-facing, so nothing leaves the machine (and no git state
 * is mutated at all) until the user confirms the proposal through the same AskUser overlay
 * the `question` tool uses. Every git call is injectable so the whole sequence is testable
 * without a repo or a network.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model } from "../ai/types.ts";
import { midTruncate } from "../minima/judge.ts";
import type { AskUser } from "../tools/question.ts";
import { repoIdentity } from "./projects.ts";

export interface PrProposal {
  branch: string;
  commit: string;
  title: string;
  body: string;
}

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export type CommandRunner = (cmd: string[], cwd: string) => Promise<RunResult>;

export const PR_DIFF_CAP_CHARS = 24_000;

const CONFIRM = "Create the PR";
const CANCEL = "Cancel";

export const PR_SYSTEM =
  "You name a pull request from its diff. Reply with ONLY a JSON object, no prose and no " +
  'code fence, with exactly these keys: "branch" (kebab-case git branch name, no spaces, ' +
  'under 50 chars, conventional prefix like feat/ fix/ chore/ when it fits), "commit" (a ' +
  'conventional-commit subject line under 72 chars), "title" (the PR title), "body" (a short ' +
  "markdown PR description: what changed and why, a few bullets at most). Describe what the " +
  "diff actually does — never invent work that is not in it.";

/**
 * Run a command with the FULL environment. Deliberately not check.ts's checkEnv() allowlist:
 * that strips SSH_AUTH_SOCK / GH_TOKEN, which is exactly what `git push` and `gh` need.
 */
const spawnRun: CommandRunner = async (cmd, cwd) => {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, out, err };
  } catch (exc) {
    return { ok: false, out: "", err: String(exc) };
  }
};

/** `/pr main` → base "main". No argument → null (caller detects the repo default). */
export function parsePrArgs(args: string): { base: string | null } {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return { base: first || null };
}

/**
 * The model's branch name goes straight into `git switch -c`, so it is a trust boundary:
 * squeeze it down to the safe git ref alphabet or fall back.
 */
export function sanitizeBranch(raw: string, fallback: string): string {
  const cleaned = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 60)
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return cleaned || fallback;
}

/** First {...} block, validated field by field; anything missing falls back. */
export function parsePrProposal(text: string, fallback: PrProposal): PrProposal {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const obj = parsed as Record<string, unknown>;
  const str = (key: string, or: string): string => {
    const v = obj[key];
    return typeof v === "string" && v.trim() ? v.trim() : or;
  };
  return {
    branch: sanitizeBranch(str("branch", ""), fallback.branch),
    commit: str("commit", fallback.commit).split("\n")[0]!.slice(0, 200),
    title: str("title", fallback.title).split("\n")[0]!.slice(0, 200),
    body: str("body", fallback.body).slice(0, 4000),
  };
}

/** minima/20260805-1432 — the fallback branch when the model can't name one. */
export function fallbackProposal(now: Date, files: string[]): PrProposal {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const body = files.length ? `Changed files:\n${files.map((f) => `- ${f}`).join("\n")}` : "";
  return {
    branch: `minima/${stamp}`,
    commit: "changes from minima session",
    title: "Changes from minima session",
    body,
  };
}

/**
 * repoIdentity falls back to a filesystem path when the remote isn't a URL, and a local or
 * self-hosted remote has no /compare/ route anyway — null means "no link to offer".
 */
export function compareUrl(identity: string, base: string, branch: string): string | null {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}\/[^/]+\/[^/]+$/i.test(identity)) return null;
  return `https://${identity}/compare/${base}...${branch}?expand=1`;
}

/** First free name in `name`, `name-2`, `name-3`, … — 20 tries, then the caller's git errors. */
export async function uniqueBranch(
  name: string,
  exists: (n: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  return name;
}

export interface RunPrOptions {
  /** Repo toplevel. */
  top: string;
  /** Base branch from the command argument; null → detect the repo default. */
  base: string | null;
  /** Cheap meta model for the naming call; null → deterministic fallback names. */
  metaModel: Model | null;
  /** Confirmation seam; null (headless) aborts before anything is mutated. */
  ask: AskUser | null;
  run?: CommandRunner;
  completeFn?: typeof complete;
  onCostUsd?: (usd: number) => void;
  now?: Date;
}

export interface RunPrOutcome {
  text: string;
  isError: boolean;
}

export async function runPr(opts: RunPrOptions): Promise<RunPrOutcome> {
  const run = opts.run ?? spawnRun;
  const git = (args: string[]) => run(["git", ...args], opts.top);
  const trimmed = async (args: string[]): Promise<string | null> => {
    const r = await git(args);
    return r.ok ? r.out.trim() : null;
  };

  // 1. Base branch: the argument, else the remote's default HEAD, else main.
  let base = opts.base;
  if (!base) {
    const head = await trimmed(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    base = head ? head.replace(/^origin\//, "") : "main";
  }
  const baseRef = (await trimmed(["rev-parse", "--verify", "--quiet", `origin/${base}`]))
    ? `origin/${base}`
    : (await trimmed(["rev-parse", "--verify", "--quiet", base]))
      ? base
      : null;
  if (!baseRef) {
    return {
      text: `No such base branch: ${base} (tried origin/${base} and ${base}).`,
      isError: true,
    };
  }

  // 2. Preflight — a detached HEAD has no branch to carry commits from.
  const current = await trimmed(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!current || current === "HEAD") {
    return { text: "HEAD is detached — check out a branch before running /pr.", isError: true };
  }

  // 3. What are we shipping: tracked changes vs base, untracked files, commits ahead.
  const diff = (await trimmed(["diff", baseRef])) ?? "";
  const status = (await trimmed(["status", "--porcelain"])) ?? "";
  const log = (await trimmed(["log", "--oneline", `${baseRef}..HEAD`])) ?? "";
  if (!diff && !status && !log) {
    return {
      text: `Nothing to open a PR for — no changes or commits ahead of ${base}.`,
      isError: false,
    };
  }
  const dirty = status.length > 0;
  const files = status
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  // 4. Name it.
  const fallback = fallbackProposal(opts.now ?? new Date(), files);
  const proposal = await proposeNames({
    metaModel: opts.metaModel,
    completeFn: opts.completeFn ?? complete,
    onCostUsd: opts.onCostUsd,
    diff,
    log,
    files,
    base,
    fallback,
  });

  // Naming the same diff twice yields the same branch — suffix rather than dying on the
  // `git switch -c` a minute later, and do it BEFORE the preview so it shows the real name.
  proposal.branch = await uniqueBranch(
    proposal.branch,
    async (n) => !!(await trimmed(["rev-parse", "--verify", "--quiet", `refs/heads/${n}`])),
  );

  // 5. Confirm — nothing above this line mutated anything.
  const resetsBase = current === base && baseRef === `origin/${base}`;
  const ahead = log ? log.split("\n").length : 0;
  const preview = [
    `Branch:  ${proposal.branch}  →  PR into ${base}`,
    dirty ? `Commit:  ${proposal.commit}` : "",
    dirty && files.length ? `Files:   ${files.length} changed` : "",
    ahead ? `Carries: ${ahead} commit(s) already ahead of ${base}` : "",
    `Title:   ${proposal.title}`,
    resetsBase ? `Also:    resets local ${base} back to origin/${base} after the push` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!opts.ask) {
    return {
      text: `${preview}\n\n/pr needs an interactive confirmation — not available here.`,
      isError: true,
    };
  }
  const answer = await opts.ask({
    question: `${preview}\n\nCreate this branch, commit, push and open the PR?`,
    header: "PR",
    options: [
      { label: CONFIRM, description: `push ${proposal.branch} and open a PR into ${base}` },
      { label: CANCEL, description: "change nothing" },
    ],
    allow_freetext: false,
  });
  if (answer !== CONFIRM) return { text: "/pr cancelled — nothing changed.", isError: false };

  // 6. Branch, commit, push.
  const switched = await git(["switch", "-c", proposal.branch]);
  if (!switched.ok) {
    return {
      text: `Could not create branch ${proposal.branch}: ${switched.err.trim()}`,
      isError: true,
    };
  }
  if (dirty) {
    const added = await git(["add", "-A"]);
    if (!added.ok) return { text: `git add failed: ${added.err.trim()}`, isError: true };
    const committed = await git(["commit", "-m", proposal.commit]);
    if (!committed.ok) {
      return { text: `git commit failed: ${committed.err.trim()}`, isError: true };
    }
  }
  const pushed = await git(["push", "-u", "origin", proposal.branch]);
  if (!pushed.ok) {
    return {
      text: `Pushed nothing — ${pushed.err.trim()}\nYour work is committed on ${proposal.branch}; \`git switch -\` returns to ${current}.`,
      isError: true,
    };
  }

  // 7. Open the PR. gh missing or unhappy still leaves a pushed branch — offer the URL.
  const lines = [`Pushed ${proposal.branch}.`];
  const pr = await run(
    [
      "gh",
      "pr",
      "create",
      "--base",
      base,
      "--head",
      proposal.branch,
      "--title",
      proposal.title,
      "--body",
      proposal.body,
    ],
    opts.top,
  );
  if (pr.ok) {
    lines.push(pr.out.trim() || `PR opened into ${base}.`);
  } else {
    lines.push(`gh could not open the PR (${(pr.err.trim() || "not installed").split("\n")[0]}).`);
    const url = compareUrl(repoIdentity(opts.top), base, proposal.branch);
    lines.push(url ? `Open it here: ${url}` : "The branch is pushed — open the PR by hand.");
  }

  // 8. Don't strand the commits on the base branch we started from — the next /pr would
  //    sweep them up again. Safe now: we've switched away and the branch is pushed.
  if (resetsBase) {
    const reset = await git(["branch", "-f", base, `origin/${base}`]);
    if (reset.ok) lines.push(`Local ${base} reset to origin/${base}.`);
  }
  return { text: lines.join("\n"), isError: false };
}

async function proposeNames(o: {
  metaModel: Model | null;
  completeFn: typeof complete;
  onCostUsd?: (usd: number) => void;
  diff: string;
  log: string;
  files: string[];
  base: string;
  fallback: PrProposal;
}): Promise<PrProposal> {
  if (!o.metaModel) return o.fallback;
  try {
    const parts = [
      `Base branch: ${o.base}`,
      o.log ? `Commits already on this branch:\n${o.log}` : "",
      o.files.length ? `Uncommitted files:\n${o.files.join("\n")}` : "",
      o.diff ? `Diff:\n${midTruncate(o.diff, PR_DIFF_CAP_CHARS)}` : "",
    ].filter(Boolean);
    const resp = await o.completeFn(
      o.metaModel,
      {
        system_prompt: PR_SYSTEM,
        messages: [new Message({ role: "user", content: parts.join("\n\n") })],
        tools: [],
      },
      { options: { timeout: 45, prompt_cache: false } },
    );
    try {
      const usd = resp.usage.cost.total;
      o.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hooks must never break the command
    }
    if (resp.stop_reason === "error") return o.fallback;
    return parsePrProposal(resp.textContent, o.fallback);
  } catch {
    return o.fallback;
  }
}
