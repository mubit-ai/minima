import { describe, expect, test } from "bun:test";
import { bashTool } from "../src/tools/index.ts";

async function run(
  args: Record<string, unknown>,
  onUpdate: ((partial: unknown) => void) | null = null,
) {
  const tool = bashTool();
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, onUpdate);
}

function bodyOf(res: { content: unknown[] }): string {
  return (res.content[0] as { text: string }).text;
}

describe("bash bounded output (H1)", () => {
  test("H1: 5000-line output is capped head+tail with both ends kept", async () => {
    const res = await run({
      command: 'for i in $(seq 0 4999); do echo "line$i padpadpad"; done',
      timeout: 30_000,
    });
    const body = bodyOf(res);
    expect(body.length).toBeLessThan(60_000);
    expect(body).toContain("line0");
    expect(body).toContain("line4999");
    expect(body).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(body.endsWith("[exit 0]")).toBe(true);
    expect(res.details?.truncated).toBe(true);
  });
});

describe("bash live streaming (H2)", () => {
  test("H2: onUpdate fires mid-run, first payload has only the first chunk", async () => {
    const updates: string[] = [];
    const res = await run({ command: "echo first; sleep 0.4; echo second", timeout: 30_000 }, (p) =>
      updates.push(String(p)),
    );
    expect(bodyOf(res)).toContain("second");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]).toContain("first");
    expect(updates[0]).not.toContain("second");
  });
});

describe("bash timeout partial output (H3)", () => {
  test("H3: timeout result includes output produced before the kill", async () => {
    const res = await run({ command: "echo partial-token-xyz; sleep 5", timeout: 300 });
    const body = bodyOf(res);
    expect(body).toMatch(/timed out/);
    expect(body).toMatch(/partial/);
    expect(body).toContain("partial-token-xyz");
  });
});
