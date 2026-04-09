/**
 * Single source of truth for the orchestrator version.
 * Reads from package.json so it stays in sync automatically.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
