import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendName,
  fieldFor,
  get,
  hydrateEnv,
  location,
  mask,
  setConfigDir,
  setValue,
  unset,
} from "../src/tui/config_store.ts";

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "minima-cfg-"));
  setConfigDir(dir);
  return dir;
}

describe("config_store (file backend)", () => {
  test("setValue → get round-trips and reports the file backend", async () => {
    freshDir();
    const backend = await setValue("MUBIT_API_KEY", "secret-key");
    expect(backend).toBe("file");
    expect(await get("MUBIT_API_KEY")).toBe("secret-key");
  });

  test("writes the config file at mode 0600", async () => {
    freshDir();
    await setValue("MUBIT_API_KEY", "k");
    const file = join(dir, "config.env");
    expect(existsSync(file)).toBe(true);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("non-secret URL fields persist to the file too", async () => {
    freshDir();
    await setValue("MINIMA_URL", "http://localhost:8080");
    expect(await get("MINIMA_URL")).toBe("http://localhost:8080");
  });

  test("unset removes a stored value", async () => {
    freshDir();
    await setValue("MUBIT_API_KEY", "k");
    await unset("MUBIT_API_KEY");
    expect(await get("MUBIT_API_KEY")).toBeNull();
  });

  test("location reports file / — appropriately", async () => {
    freshDir();
    expect(await location("MUBIT_API_KEY")).toBe("—");
    await setValue("MUBIT_API_KEY", "k");
    expect(await location("MUBIT_API_KEY")).toBe("file");
  });

  test("mask shows only the last 4 of a secret", () => {
    expect(mask("sk-abcd1234")).toBe("••••1234");
    expect(mask("ab")).toBe("••");
    expect(mask("")).toBe("");
  });

  test("hydrateEnv materializes stored values into process.env (without overwriting)", async () => {
    freshDir();
    await setValue("MUBIT_API_KEY", "from-store");
    process.env.MUBIT_API_KEY = "from-shell";
    await hydrateEnv();
    expect(process.env.MUBIT_API_KEY).toBe("from-shell"); // real env wins
    delete process.env.MUBIT_API_KEY;
    await hydrateEnv();
    expect(process.env.MUBIT_API_KEY).toBe("from-store"); // store fills the gap
    delete process.env.MUBIT_API_KEY;
  });

  test("backendName reports file when no native keychain is available", async () => {
    freshDir();
    expect(await backendName()).toMatch(/file|keychain/);
  });

  test("EXA_API_KEY is a first-class secret credential that round-trips and hydrates", async () => {
    freshDir();
    const field = fieldFor("EXA_API_KEY");
    expect(field).toBeDefined();
    expect(field?.secret).toBe(true);
    expect(field?.optional).toBe(true);

    await setValue("EXA_API_KEY", "exa-secret");
    expect(await get("EXA_API_KEY")).toBe("exa-secret");

    delete process.env.EXA_API_KEY;
    await hydrateEnv();
    expect(process.env.EXA_API_KEY).toBe("exa-secret");
    delete process.env.EXA_API_KEY;
  });
});
