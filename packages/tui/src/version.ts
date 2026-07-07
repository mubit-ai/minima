/**
 * The harness version, read from package.json at build time (Bun bundles JSON imports
 * into the compiled binary). Sent as `X-Minima-Client` on every service request so the
 * server can compat-gate schema changes (see docs/agent-core-architecture.md §4.11).
 */

import pkg from "../package.json";

export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";
