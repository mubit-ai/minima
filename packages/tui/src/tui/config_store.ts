/**
 * Per-user credential store — keychain-first, 0600-file fallback.
 *
 * Port of minima_harness/tui/config_store.py. Secrets go to the OS keychain (via
 * `keytar`, when importable) — otherwise to `~/.minima-harness/config.env` written 0600.
 * Non-secret config (URLs) always lives in the file. hydrateEnv() materialises stored
 * values into process.env with setdefault precedence (real shell env + project .env win).
 *
 * `keytar` is a native module and won't bundle into the compiled binary; when absent,
 * everything transparently falls back to the file backend (which is always available).
 */

import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "../ai/provider_catalog.ts";
import { DEFAULT_MINIMA_URL } from "../minima/config.ts";

const KEYRING_SERVICE = "minima-harness";
const GLOBAL_DIR_DEFAULT = join(homedir(), ".minima-harness");

let globalDir = GLOBAL_DIR_DEFAULT;
const configFilePath = () => join(globalDir, "config.env");

/** Override the config directory (tests). */
export function setConfigDir(dir: string): void {
  globalDir = dir;
}

export interface Field {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
  default?: string;
  aliases?: string[];
}
export interface Section {
  title: string;
  note: string;
  fields: Field[];
}

function providerFields(): Field[] {
  return PROVIDERS.filter((p) => p.showInConfig).flatMap((p) => {
    const primary = p.envVars[0];
    if (!primary) return [];
    const alts = p.envVars.slice(1);
    return [
      {
        key: primary,
        label: p.blurb ? `${p.displayName} — ${p.blurb}` : `${p.displayName} API key`,
        secret: true,
        optional: true,
        aliases: alts,
      },
    ];
  });
}

export const SECTIONS: Section[] = [
  {
    title: "LLM provider keys",
    note: "Keys to RUN the chosen model — set any one (or several). Local runtimes (Ollama, vLLM, LM Studio) need no key.",
    fields: providerFields(),
  },
  {
    title: "Mubit / Minima routing",
    note: "Mubit memory backend + the Minima recommender endpoint.",
    fields: [
      {
        key: "MUBIT_API_KEY",
        label: "Mubit API key (memory + routing auth)",
        secret: true,
        optional: false,
      },
      {
        key: "MINIMA_URL",
        label: "Minima endpoint URL",
        secret: false,
        optional: true,
        default: DEFAULT_MINIMA_URL,
      },
      {
        key: "MINIMA_API_KEY",
        label: "Minima auth (optional; falls back to MUBIT_API_KEY)",
        secret: true,
        optional: true,
      },
      { key: "MUBIT_ENDPOINT", label: "Mubit endpoint URL", secret: false, optional: true },
      {
        key: "MUBIT_CONSOLE_URL",
        label: "Mubit console URL (used by /auth)",
        secret: false,
        optional: true,
        default: "https://console.mubit.ai",
      },
    ],
  },
  {
    title: "Web tools",
    note: "Exa API key for the web_search / web_fetch tools (https://exa.ai). Optional — the web tools stay unavailable until it is set.",
    fields: [
      {
        key: "EXA_API_KEY",
        label: "Exa API key (web search)",
        secret: true,
        optional: true,
      },
    ],
  },
];

export function allFields(): Field[] {
  return SECTIONS.flatMap((s) => s.fields);
}

export function fieldFor(key: string): Field | undefined {
  return allFields().find((f) => f.key === key);
}

export function mask(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  return "•".repeat(4) + value.slice(-4);
}

// --- keychain (optional) -------------------------------------------------------------

let keychain:
  | {
      get: (k: string) => Promise<string | null>;
      set: (k: string, v: string) => Promise<void>;
      del: (k: string) => Promise<void>;
    }
  | null
  | undefined;

async function loadKeychain() {
  if (keychain !== undefined) return keychain;
  try {
    const mod = await import("keytar");
    keychain = {
      get: (k) => mod.getPassword(KEYRING_SERVICE, k),
      set: (k, v) => mod.setPassword(KEYRING_SERVICE, k, v),
      del: async (k) => {
        await mod.deletePassword(KEYRING_SERVICE, k);
      },
    };
  } catch {
    keychain = null; // native module unavailable (e.g. compiled binary) → file fallback
  }
  return keychain;
}

export async function backendName(): Promise<string> {
  return (await loadKeychain()) ? "keychain" : "file";
}

// --- file backend (env-format, mode 0600) --------------------------------------------

async function readFileStore(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const text = await readFile(configFilePath(), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const k = line.slice(0, eq).trim();
      const v = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      out[k] = v;
    }
  } catch {
    // missing file
  }
  return out;
}

async function writeFileStore(data: Record<string, string>): Promise<void> {
  await mkdir(globalDir, { recursive: true });
  const lines = Object.entries(data)
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  const body = `# minima-harness config — managed by \`minima config\`\n${lines.join("\n")}\n`;
  // O_CREAT 0600 so the file is owner-only from the moment it exists.
  const handle = await open(configFilePath(), "w", 0o600);
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await chmod(configFilePath(), 0o600);
  } catch {
    // best-effort
  }
}

async function fileSet(key: string, value: string): Promise<void> {
  const data = await readFileStore();
  data[key] = value;
  await writeFileStore(data);
}

async function fileDelete(key: string): Promise<void> {
  const data = await readFileStore();
  if (key in data) {
    delete data[key];
    await writeFileStore(data);
  }
}

// --- public get / set / unset --------------------------------------------------------

export async function get(key: string): Promise<string | null> {
  const f = fieldFor(key);
  const secret = f?.secret ?? true;
  if (secret) {
    const kc = await loadKeychain();
    if (kc) {
      try {
        const val = await kc.get(key);
        if (val) return val;
      } catch {
        // fall through to file
      }
    }
  }
  return (await readFileStore())[key] ?? null;
}

/** Persist `value`. Returns the backend used: "keychain" or "file". */
export async function setValue(key: string, value: string): Promise<string> {
  const f = fieldFor(key);
  const secret = f?.secret ?? true;
  if (secret) {
    const kc = await loadKeychain();
    if (kc) {
      try {
        await kc.set(key, value);
        await fileDelete(key); // don't leave a stale plaintext copy behind
        return "keychain";
      } catch {
        // fall through to file
      }
    }
  }
  await fileSet(key, value);
  return "file";
}

export async function unset(key: string): Promise<void> {
  const kc = await loadKeychain();
  if (kc) {
    try {
      await kc.del(key);
    } catch {
      // best-effort
    }
  }
  await fileDelete(key);
}

/** Where `key` is stored: "keychain" | "file" | "—" (unset). */
export async function location(key: string): Promise<string> {
  const f = fieldFor(key);
  const secret = f?.secret ?? true;
  if (secret) {
    const kc = await loadKeychain();
    if (kc) {
      try {
        if (await kc.get(key)) return "keychain";
      } catch {
        // fall through
      }
    }
  }
  return (await readFileStore())[key] !== undefined ? "file" : "—";
}

/** Load stored config into process.env (setdefault → real env / project files win). */
export async function hydrateEnv(): Promise<void> {
  for (const f of allFields()) {
    const val = await get(f.key);
    if (!val) continue;
    if (process.env[f.key] === undefined) process.env[f.key] = val;
    for (const alias of f.aliases ?? []) {
      if (process.env[alias] === undefined) process.env[alias] = val;
    }
  }
}
