const { existsSync, readFileSync } = require("fs");
const { join } = require("path");

// Read version from mcp-server/package.json (relative to this script)
let version = "?";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "mcp-server", "package.json"), "utf8")
  );
  version = pkg.version;
} catch {}

// Banner
console.log(`░▒▓ CLAUDE // AGENT-FLYWHEEL v${version} ▓▒░`);

// Check for existing session
const checkpoint = join(process.cwd(), ".pi-flywheel", "checkpoint.json");
if (existsSync(checkpoint)) {
  try {
    const data = JSON.parse(readFileSync(checkpoint, "utf8"));
    const s = data.state;
    if (s && s.phase && s.phase !== "idle" && s.phase !== "complete") {
      const goal = s.selectedGoal ? ` goal="${s.selectedGoal}"` : "";
      console.log(
        `\u26a0\ufe0f  Previous flywheel session detected: phase=${s.phase}${goal}. Run /agent-flywheel:start to resume or /agent-flywheel:flywheel-stop to reset.`
      );
    }
  } catch {}
}
