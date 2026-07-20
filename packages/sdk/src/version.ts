/**
 * SDK version, read from package.json (kept in lockstep with pyproject.toml and
 * packages/tui). Sent as `x-minima-client` on every request so the server can
 * compat-gate schema changes.
 */

import pkg from "../package.json";

export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";
