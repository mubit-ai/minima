import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expand } from "./_io.ts";

const MAX_FILE_BYTES = 50_000;

export function expandAtFiles(text: string, cwd: string = process.cwd()): string {
  const tokens = text.split(/\s+/);
  const out: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("@") && token.length > 1) {
      const rawPath = token.slice(1);
      const p = expand(rawPath);
      const full = isAbsolute(p) ? p : resolve(cwd, p);

      if (existsSync(full) && statSync(full).isFile()) {
        try {
          const content = readFileSync(full, "utf8");
          if (content.length <= MAX_FILE_BYTES) {
            out.push(`<file path="${rawPath}">\n${content}\n</file>`);
            continue;
          }
          out.push(
            `<file path="${rawPath}">\n${content.slice(0, MAX_FILE_BYTES)}\n…(truncated, ${content.length - MAX_FILE_BYTES} bytes omitted)\n</file>`,
          );
          continue;
        } catch {
          // fall through to push the raw token
        }
      }
    }
    out.push(token);
  }

  return out.join(" ");
}
