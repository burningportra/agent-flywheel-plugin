# Phase 3: APR-Pro Inversion — Anti-Patterns Agent-Flywheel Should Avoid

**Date**: 2026-05-05
**Researcher**: CoralBrook (claude-opus-4-7)
**Question**: What does APR-Pro do **badly** or **unconventionally** that agent-flywheel should explicitly **avoid**?

---

## 1. Bash as the Primary Orchestration Language (~6,900 LOC monolith)

### What APR does
The entire `apr` CLI is one bash script (~6,904 lines) that handles config parsing, YAML loading, browser session orchestration, JSON emission, TOON encoding, lock management, metrics computation, TUI rendering, and self-update — all in shell. There is no module boundary; functions like `robot_resolve_output_format`, `robot_json_to_toon`, `collect_metrics` live side-by-side in one file with shared globals.

### Why it's problematic
- **No type safety, no static checking** — typos in variable names silently expand to empty strings (`set -u` helps but doesn't catch logic errors).
- **Quoting hell** — every string interpolation is a potential injection or word-splitting bug, especially when forwarding user-supplied workflow names into `jq -nc --arg ...` calls.
- **Concurrent state is hand-rolled** — bash has no real primitives for locks, queues, or atomic counters; APR uses `.lock` files with a 2-hour stale TTL (more on that below).
- **Refactoring at 7K lines is essentially manual** — no rename-symbol, no test-driven decomposition without a major rewrite. The script will keep accreting.
- **Cross-platform footguns** — `wc -c` counts bytes on Linux but bytes-or-chars depending on locale on macOS; `date`, `sed`, `readlink` all diverge. APR papers over this with detection branches that themselves accrue bugs.

### How agent-flywheel risks the same trap
The flywheel CLI surface (`flywheel_plan`, `flywheel_review`, `orch_*` MCP tools) is implemented in TypeScript/Node — already past this trap. **But** the swarm orchestration layer (NTM tmux fan-out, the recently-added cod/pi prioritization in `c0cf590`, robot-send shell glue, picked-up-plan menu in Step 5.45) is leaking shell scripts into the hot path. Each new shell helper is a future 6,900-line bash monolith if not actively resisted.

### Guidance
**In flywheel, do this instead**: Keep all non-trivial control flow in TypeScript (or Rust for performance-critical bits like `br`/`bv`). Treat shell as a thin invocation layer (≤50 lines per script, single responsibility, no parsing logic). When tempted to add a `case`/`while`/`jq` pipeline to a `.sh` file, port it to a TS module instead.

---

## 2. Browser-Driven Oracle as the Only LLM Transport

### What APR does
Every round of refinement requires Oracle to drive a real Chromium instance against ChatGPT, paste the bundled prompt into the web textbox, and poll the DOM for stability. First-round invocation needs `apr run 1 --login --wait` so a human can manually log into ChatGPT in the browser. For headless/CI use, APR documents an `oracle serve` mode that runs the browser on a separate machine over Tailscale.

### Why it's problematic
- **Browser auth is fragile**: ChatGPT changes its DOM, adds bot-detection (Cloudflare, Arkose), expires sessions, rotates cookies. Any of these silently break automation with no semantic error code — just a polling timeout.
- **No first-class headless story**: "Run a browser on another machine and tunnel to it" is not a CI primitive. Agents in GitHub Actions, Vercel, or sandboxed runners cannot do this without a persistent home-base host. This is a single-author tool's deployment model, not an agent's.
- **TOS / detection risk**: scripted ChatGPT web is an arms race; the moment OpenAI tightens detection, every APR user is dead in the water.
- **Cost is hidden in the subscription**: there's no per-call accounting, retry backoff, or rate-limit awareness — the model is a black box behind a browser.
- **Coupling the orchestrator to browser auth means anything orchestrator does (validate, history, diff, status) inherits the browser-availability dependency** even when no LLM call is needed.

### How agent-flywheel risks the same trap
Flywheel currently spawns Claude Code panes via NTM, which means real Claude/Codex/Gemini CLIs with real API auth. Good. **But** the recent `cod`/`pi` fallback work (commit `c0cf590`, the Pi/Gemini fallback memory note) hints at a temptation to wire in browser-based or session-CLI-based agents (Pi, ChatGPT desktop, etc.) when API tier is exhausted. Each browser-backed agent re-imports APR's failure mode.

### Guidance
**In flywheel, do this instead**: Only use LLM transports with stable, server-to-server auth (API keys, OAuth client credentials, Anthropic SDK, Codex CLI talking to OpenAI API). Treat any "browser-driven CLI" as a temporary human-loop escape hatch, never a swarm primitive. Document this as a hard rule in the swarm playbook so future contributors don't sneak in a Pi/ChatGPT-web fallback.

---

## 3. Hardcoded Round-Count Convergence Pattern (1-3 / 4-7 / 8-12 / 13+)

### What APR does
The README literally documents a fixed convergence schedule:
```
Round 1-3:   Major architectural fixes
Round 4-7:   Architecture refinements
Round 8-12:  Nuanced optimizations
Round 13+:   Polishing
```
Users invoke `apr run 5` with the round number as a command-line argument. The "convergence detection" is line/word/char delta — the *count* itself is human-driven, not adaptive.

### Why it's problematic
- **The schedule is a folk theorem, not a measurement**. It encodes the author's experience on one document type (security protocols). A small README converges in 2 rounds; a 50K-line spec might still see major restructuring at round 12.
- **The user picks the round number**, which means the user is doing the convergence judgment the tool claims to automate. The metrics dashboard is post-hoc justification, not a stopping rule.
- **Off-by-one between "what round am I on" and "what round should I run" is a UX smell** that proliferates: `apr run 5`, `apr show 5`, `apr diff 3 5`, `apr attach apr-default-round-3` — round numbers are addressable identifiers, baked into filenames (`round_5.md`), git commits, lock paths.
- **No concept of branching or rollback**: if round 7 produces worse output than round 6, you can't rewind — the round graph is a linear chain.

### How agent-flywheel risks the same trap
Step 5.45's "validate / approve / refine / scrap" picked-up-plan menu (commit `617be66`) is exactly the surface where a fixed schedule could leak in. If "refine" is implemented as "run review sub-agent again with no termination criterion other than user clicks approve", we end up with the same anti-pattern: humans deciding how many rounds, dressed up as automation. Wave numbering in `flywheel_advance_wave` has the same risk — wave-N as an identifier in beads/checkpoints.

### Guidance
**In flywheel, do this instead**: Make the stopping rule data-driven and the round count an emergent property, not a parameter. Track convergence via *behavioral* signals (review verdict, bead-test pass rate, scope-drift score) rather than line/word delta. Wave numbers should be opaque ULIDs in storage, only rendered as `wave-N` in UI for current sessions.

---

## 4. File-Based State in `.apr/sessions/` with 2-Hour Stale-Lock TTL

### What APR does
Concurrent runs are gated by `.apr/rounds/<workflow>/.lock`. Crashed processes leave stale locks; APR auto-cleans locks older than 2 hours. PIDs of background runs are tracked in `.apr/.sessions/round-N.pid`. State recovery from a crashed round is undocumented — there's no "resume" verb, only `attach`.

### Why it's problematic
- **2-hour TTL is arbitrary and unsafe**. A round legitimately running for 90 minutes with extended thinking is alive; a process that got SIGKILL'd at minute 1 occupies the lock for 119 more minutes. There is no liveness check (PID still exists? still in our process group? still actually doing work?).
- **PID-based liveness is unreliable across reboots and PID reuse**. After a reboot, `.lock` contains a PID that may now belong to an unrelated process; APR has no way to tell.
- **No transactional crash recovery**: if APR dies between "GPT Pro returned output" and "git commit round_5.md", the partially-written file may be re-read on next run, or worse, committed by a later round.
- **`.apr/` is hand-rolled hierarchical state** — workflows YAML, analytics JSON, rounds markdown, sessions PIDs, locks — with no schema versioning. Upgrading from 1.2.2 to 1.3.0 has no migration story documented; users will hit silent corruption.

### How agent-flywheel risks the same trap
Flywheel's checkpoint system, Agent Mail file reservations, and `flywheel_doctor`'s "orphaned worktrees" detection (already a thing) are the analog. The recent picked-up-plan menu (`617be66`) operates on plan files that may have been left behind by a crashed prior session — same recovery question. The Agent Mail `force_release_file_reservation` tool exists precisely because reservations can leak, which is the same shape as APR's stale-lock problem.

### Guidance
**In flywheel, do this instead**: Use a real lock service with explicit TTL **renewal** (which Agent Mail already does via `renew_file_reservations`), not a 2-hour wall-clock cleanup. Make all state writes journaled (write to `.tmp`, fsync, rename) so crash recovery is well-defined. Schema-version every state directory and write a migrator before bumping versions.

---

## 5. TOON Encoding — NIH Format Behind a JSON Wrapper

### What APR does
Robot mode supports a "TOON" output format ("token-optimized") via `tru` (toon_rust), with precedence `--format > APR_OUTPUT_FORMAT > TOON_DEFAULT_FORMAT > json`. TOON is described as "trusted output" / "token-optimized" — an encoding that compresses JSON for LLM consumption.

### Why it's problematic
- **TOON is not a recognized standard** outside this author's ecosystem (search the IETF, the W3C, the JSON working groups — nothing). Adopting it ties flywheel to one person's binary.
- **Encoding for LLM token efficiency is dubious**: modern frontier models tokenize JSON near-optimally, and the "savings" from a custom format are typically <10% of payload — far less than the cost of one extra tool call. The premise rarely pays off.
- **Graceful-degradation logic adds complexity**: APR has to detect `tru` availability, fall back to JSON, log a warning. Every consumer must handle two formats.
- **Debugging tooling doesn't exist**: `jq` doesn't parse TOON; you can't `curl | jq .data.workflows[]`. Anything outside APR's bubble has to convert first.
- **It violates the principle of using the boring choice for inter-process protocols**. JSON (or MessagePack if you really need binary) has overwhelming ecosystem support.

### How agent-flywheel risks the same trap
Any tempting "structured output" format invented inside agent-flywheel for MCP tool responses or inter-agent messages would repeat this. The bead-graph JSON, agent-mail message bodies, and flywheel_review verdicts are all places where someone might propose a custom-encoded format for "agent efficiency."

### Guidance
**In flywheel, do this instead**: Stick to JSON for tool I/O and Markdown for agent messages. If payload size becomes a real bottleneck (validated with measurements), reach for gzip + base64 over JSON, or MessagePack — both have decoders in every language. Never invent a format.

---

## 6. Workflow YAML Schema Leaks Implementation Detail to the User

### What APR does
Every workflow is a YAML file the user must compose:
```yaml
name: fcp-spec
description: Flywheel Connector Protocol specification
readme: README.md
spec: FCP_Specification_V2.md
implementation: docs/fcp_model_connectors_rust.md
model: gpt-5.2-pro
```
The user has to know the exact field names, the relative-path semantics, the model identifier string, which fields are required vs. optional. The `apr setup` wizard generates this file but users edit it by hand for non-default cases.

### Why it's problematic
- **The schema is the API**. Adding a field (say, `oracle_session: shared`) is a breaking change for anyone whose YAML is checked in. Renaming `implementation` → `impl` requires migrations.
- **Model strings leak provider details**: `gpt-5.2-pro` ties the workflow to OpenAI; switching to Claude requires the user to learn a different model identifier. The tool should abstract this.
- **YAML's quoting rules** (no, `model: gpt-5.2-pro` is fine, but `model: 5.2-pro` would parse as a number) are a classic foot-gun for non-developers.
- **No schema validation surface for the user**: errors come at run time, not edit time. There's no JSON-Schema published, no LSP integration, no `apr validate-config`.

### How agent-flywheel risks the same trap
Flywheel's plan files (under `docs/plans/` or wherever the picked-up-plan menu reads from), bead JSONL schemas, and any per-project `.flywheel/` config are the analog. The Step 5.45 "pick up existing plan" flow specifically reads user-authored plan files — that surface should hide as much schema as possible.

### Guidance
**In flywheel, do this instead**: Hide configuration behind tools, not files. The CLI should *generate and own* config files; users interact via commands (`flywheel set-default-workflow`, `flywheel attach-doc`). When config files must be human-editable, ship a JSON Schema, validate at write time, and version the schema explicitly.

---

## 7. Self-Update via curl-pipe-bash with SHA-256 Inside the Same Repo

### What APR does
The README's headline install is:
```bash
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/automated_plan_reviser_pro/main/install.sh?$(date +%s)" | bash
```
The installer fetches the `apr` binary from `main` and verifies a SHA-256 checksum that *also* lives in the same repo (auto-updated by `auto-checksum.yml`). `apr update` runs the same flow.

### Why it's problematic
- **Curl | bash is not auditable**. Users execute whatever is on `main` at the moment of install. The cache-busting `?$(date +%s)` query string actively defeats CDN caching, so even repeat installs from the same minute fetch fresh.
- **Same-repo checksum gives no security**: if the repo is compromised, attacker updates both `apr` and the checksum. SHA-256 only protects against transit corruption, not adversaries.
- **No signature verification**: no `gpg --verify`, no Sigstore, no codesign. Compare to Homebrew, which gives you formula PR review and bottle signing.
- **Pinning is hostile**: the default fetches from `main`, not a tag. `APR_VERSION=x.y.z` is documented but not the default; users get latest-of-main.

### How agent-flywheel risks the same trap
Flywheel ships as a Claude Code plugin and through NTM/CASS tooling, which already has plugin-marketplace versioning. But any future "install bv" or "install br" or "release dsr" surface must avoid this pattern.

### Guidance
**In flywheel, do this instead**: Distribute via package managers (npm, cargo, brew formula) with proper signing. If a curl-pipe-bash escape hatch is needed for first-touch convenience, default to the latest *tagged release* (not `main`), publish checksums to a separate verification surface (Sigstore, GitHub release signatures), and document `--version` pinning prominently. The `dsr` skill already pushes this direction; keep it.

---

## 8. Inline Document Pasting via DOM Automation as the Bundling Strategy

### What APR does
APR uses Oracle's `--browser-attachments never` mode and **pastes the entire bundled prompt directly into the chat textbox** rather than uploading files. This means a multi-document bundle (README + spec + implementation) is concatenated in-memory and shoved into a textarea via DOM scripting.

### Why it's problematic
- **Token-limit silently truncates** — if the bundle exceeds the model's context window, the chat input cuts off; APR has no pre-flight measurement that maps document size to model context limits.
- **DOM input is lossy for complex content**: code blocks, fenced markdown, tabular data can be mangled by IME composition events, paste sanitization, or auto-formatting on the chat side.
- **No file attachment means no provenance**: GPT Pro sees a wall of text, not "here's README.md, here's spec.md" with explicit boundaries beyond ASCII markers like `[DOCUMENT MARKER: README]`. Models occasionally confuse which document is which.
- **The "30s stable, 12 polling cycles" output detection is needed precisely because there's no real completion signal** — the API would emit a structured `done` event; DOM polling has to invent stability heuristics.

### How agent-flywheel risks the same trap
Flywheel agent panes communicate via `ntm robot-send` writing into tmux input — a similar "shove text into a TTY and hope it parses" pattern. Picked-up-plan reading is similar: the plan file content is read and embedded into a prompt template. Any time we string-concatenate user content into a model prompt, we're at risk of silent truncation, marker collision (what if the user's plan contains `[DOCUMENT MARKER: README]`?), or loss of structure.

### Guidance
**In flywheel, do this instead**: Use proper API requests with structured content blocks (Claude's `messages` array with multiple `content` parts, OpenAI's tool-call structured inputs). Pre-compute token counts before sending, fail loudly on overflow, and use unique unguessable markers (UUIDs, random hex) when delimiters are unavoidable. Treat NTM tmux-piping as the user-facing convenience, not the source of truth.

---

## Summary Table

| # | APR Anti-Pattern | Flywheel Surface At Risk | One-Line Guidance |
|---|------------------|--------------------------|-------------------|
| 1 | 6,900-line bash monolith | NTM/swarm shell glue | Keep control flow in TS/Rust; shell stays ≤50 LOC |
| 2 | Browser-driven Oracle for LLM | Pi/ChatGPT-web fallback temptation | Only use server-to-server auth transports |
| 3 | Hardcoded round-count schedule | Step 5.45 refine loop, wave numbering | Stopping rule must be behavioral, not numeric |
| 4 | `.apr/` files + 2hr stale-lock TTL | Checkpoints, file reservations, plan files | Use renewable leases + journaled writes |
| 5 | TOON NIH encoding | Bead/agent-mail message formats | Stick to JSON + Markdown |
| 6 | YAML workflow schema leaked to user | Plan files, `.flywheel/` config | Hide config behind tools, version schemas |
| 7 | curl-pipe-bash from `main` w/ same-repo checksum | bv/br/dsr distribution | Tagged releases, package managers, signing |
| 8 | DOM paste of concatenated documents | NTM robot-send, plan embedding | Structured content blocks, pre-flight token counts |

---

## Research Artifacts
- APR README: indexed as `apr-pro-readme` (112 sections)
- APR research findings: indexed as `apr-pro-research-findings` (35 sections)
- APR installer: indexed as `apr-pro-installer` (75 sections)
- Phase 1 baseline: `docs/research/apr-pro-phase1-explore.md`
