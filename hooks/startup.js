const { existsSync, readFileSync } = require("fs");
const { join, delimiter } = require("path");

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
        `⚠️  Previous flywheel session detected: phase=${s.phase}${goal}. Run /agent-flywheel:start to resume or /agent-flywheel:flywheel-stop to reset.`
      );
    }
  } catch {}
}

// Fast PATH scan for flywheel-owned CLIs. If any are missing, print a single
// concrete heal command instead of leaving the user stuck. Bounded — sync
// existsSync on PATH dirs only, no exec, no network. Skip via
// FLYWHEEL_SKIP_DEP_CHECK=1 if the noise is unwanted.
if (process.env.FLYWHEEL_SKIP_DEP_CHECK !== "1") {
  try {
    const required = ["br", "bv", "ntm", "cm"];
    const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
    const onPath = (bin) => {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, bin))) return true;
      }
      return false;
    };
    const missing = required.filter((b) => !onPath(b));
    if (missing.length > 0) {
      console.log(
        `⚠️  Missing flywheel CLIs: ${missing.join(", ")}. Run /agent-flywheel:flywheel-doctor to auto-install (or pass --auto for unattended).`
      );
    }
  } catch {}
}
