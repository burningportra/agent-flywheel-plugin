/**
 * Single source of truth for the agent-flywheel version.
 * Reads from package.json so it stays in sync automatically.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
export const VERSION = pkg.version;
//# sourceMappingURL=version.js.map