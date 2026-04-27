import { polishInstructions, summaryInstructions, realityCheckInstructions, deSlopifyInstructions, landingChecklistInstructions, learningsExtractionPrompt } from "./prompts.js";
import { reflectMemory, readMemory } from "./memory.js";
import { readBeads, extractArtifacts as extractBeadArtifacts } from "./beads.js";
import { agentMailTaskPreamble } from "./agent-mail.js";
import { detectUbs } from "./coordination.js";
import { resilientExec } from "./cli-exec.js";
import { getDomainChecklist, formatDomainReviewItems } from "./domain-knowledge.js";
export async function runGuidedGates(exec, cwd, st, extraInfo, saveState) {
    const allBeads = await readBeads(exec, cwd);
    const activeBeads = st.activeBeadIds
        ? allBeads.filter((b) => st.activeBeadIds.includes(b.id))
        : allBeads;
    const allArtifacts = [...new Set(activeBeads.flatMap((b) => extractBeadArtifacts(b)))];
    const goal = st.selectedGoal ?? "Unknown goal";
    const beadResults = Object.values(st.beadResults ?? {});
    const polish = polishInstructions(goal, allArtifacts);
    const summaryText = summaryInstructions(goal, activeBeads, beadResults);
    // Load CASS memory context for review gates (best-effort)
    let memoryContext = "";
    try {
        const mem = readMemory(cwd, `review patterns ${goal}`);
        if (mem)
            memoryContext = `\n\n## Prior Session Learnings\n${mem}\n`;
    }
    catch { /* CASS unavailable — proceed without */ }
    // Domain-specific review items based on tech stack
    const domainChecklist = st.repoProfile ? getDomainChecklist(st.repoProfile) : null;
    const domainReviewExtras = domainChecklist ? formatDomainReviewItems(domainChecklist) : "";
    st.iterationRound = (st.iterationRound ?? 0) + 1;
    const round = st.iterationRound;
    saveState();
    // Sequential guided flow — resume from saved gate index.
    // Gates marked auto: true run immediately without prompting the user.
    // Gates marked auto: false return all options for the caller to present.
    const gates = [
        { emoji: "search", label: "Fresh self-review", desc: "read all new code with fresh eyes", auto: true },
        { emoji: "peers", label: "Peer review", desc: "parallel agents review each other's work", auto: false },
        { emoji: "tests", label: "Test coverage", desc: "check unit tests + e2e, create tasks for gaps", auto: true },
        { emoji: "slop", label: "De-slopify", desc: "remove AI writing patterns from docs", auto: true },
        { emoji: "adversarial", label: "Adversarial reading", desc: "trace random execution flows to find hidden bugs", auto: true },
        { emoji: "ubs", label: "UBS scan", desc: "run ubs on changed files, fix all issues", auto: true },
        { emoji: "commit", label: "Commit", desc: "logical groupings with detailed messages", auto: false },
        { emoji: "ship", label: "Ship it", desc: "commit, tag, release, deploy, monitor CI", auto: false },
        { emoji: "land", label: "Landing checklist", desc: "verify session is resumable", auto: false },
    ];
    // Agent-mail threading: sub-agents bootstrap their own sessions via
    // agentMailTaskPreamble() injected into their tasks. Thread IDs are
    // gate-scoped (e.g. "peer-review-r1", "hit-me-r1").
    let chosen;
    const startGate = st.currentGateIndex ?? 0;
    for (let i = startGate; i < gates.length; i++) {
        const gate = gates[i];
        if (gate.auto) {
            // Auto-advance: run this gate immediately without prompting
            st.currentGateIndex = i + 1;
            saveState();
            chosen = `${gate.emoji} ${gate.label} - ${gate.desc}`;
            break;
        }
        // Non-auto gates: auto-select the first non-skipped option
        // (In MCP context, we auto-execute rather than prompt interactively)
        st.currentGateIndex = i + 1;
        saveState();
        chosen = `${gate.emoji} ${gate.label} - ${gate.desc}`;
        break;
    }
    if (!chosen)
        chosen = "done";
    const callbackHint = `\n\nAfter completing this, call \`flywheel_review\` with beadId "__gates__" and verdict "pass" for the next gate.`;
    // Regression hint appended to gates where fundamental issues might surface.
    // Flywheel: "If a gate fails, drop back a phase instead of pushing forward."
    const regressionHint = `\n\n---\n**If this gate revealed fundamental issues:**\n` +
        `- \`flywheel_review\` with beadId \"__regress_to_beads__\" -> go back to bead creation\n` +
        `- \`flywheel_review\` with beadId \"__regress_to_plan__\" -> go back to plan refinement\n` +
        `- \`flywheel_review\` with beadId \"__regress_to_implement__\" -> go back to implementation`;
    if (chosen === "done" || chosen.startsWith("done")) {
        st.currentGateIndex = 0;
        saveState();
        // guide: run `cm reflect` between sessions to mine patterns from logs
        try {
            reflectMemory(cwd);
        }
        catch { /* best-effort */ }
        const learningsText = learningsExtractionPrompt(goal, activeBeads.map((b) => b.id));
        // Self-improvement loop: save structured feedback for future flywheel runs
        try {
            const { collectFeedback, saveFeedback } = await import("./feedback.js");
            const feedback = collectFeedback(st);
            saveFeedback(cwd, feedback);
        }
        catch {
            // Feedback collection is best-effort
        }
        // Include prompt effectiveness summary if available
        let promptEffectivenessInfo = "";
        try {
            const { formatPromptEffectiveness } = await import("./feedback.js");
            const peInfo = formatPromptEffectiveness();
            if (peInfo)
                promptEffectivenessInfo = `\n\n${peInfo}`;
        }
        catch { /* best-effort */ }
        return {
            content: [
                { type: "text", text: `${summaryText}${extraInfo}\n\nOrchestration complete after ${round} round(s).${promptEffectivenessInfo}\n\n---\n${learningsText}` },
            ],
            details: { complete: true, rounds: round },
        };
    }
    if (chosen.startsWith("search")) {
        return {
            content: [
                {
                    type: "text",
                    text: `## Fresh Self-Review - Round ${round}${memoryContext}\n\n**⚠ DO NOT close, kill, restart, or retire any NTM panes during this gate.** If an impl swarm is still alive (tmux session present, panes responsive), the live codex/claude-code agents in those panes are the right reviewers — they wrote the code and have the most context. Self-review is delegation, not coordinator solo work, and it MUST NOT trigger pane teardown.\n\n**Routing:**\n1. Run \`list_window_identities\` (Agent Mail) and \`ntm --robot-tail\` to confirm which NTM panes are still alive and which agent identity each holds.\n2. For each closed bead in this wave, dispatch the self-review back to the *same* pane that implemented it via \`ntm --robot-send\` (NOT \`ntm send\` — CASS-dedup will silently abort it). One pane = one bead's self-review.\n3. If a pane has gone silent or been recycled, fall back to coordinator-side review for that bead's files only — do NOT spawn fresh reviewers and do NOT touch other panes.\n4. The tender daemon should already be \`kill -TERM\`'d at this point (see \`_implement.md\` Post-wave bridge). Do NOT start a new daemon and do NOT issue \`ntm --robot-restart-pane\`, \`--hard-kill\`, or \`tmux kill-pane\` against any pane that is responsive.\n\n**Self-review prompt to dispatch to each pane (substitute the pane's bead ID + files):**\n\nCarefully re-read ALL new and modified code with fresh eyes. For each file changed, work through these 4 questions:\n\n1. **Is it correct?** Does the implementation actually do what the bead description says it should?\n2. **Are edge cases handled?** Empty inputs, concurrent access, error paths, boundary conditions - what breaks under stress?\n3. **Are there similar issues elsewhere?** If you found a bug, search for the same pattern in other files. Bugs travel in packs.\n4. **Was the approach right?** Sometimes the implementation is correct but there's a simpler or more robust alternative. Consider it now, not after review.\n\nFix everything you find. If you find a bug, do the pattern search (#3) before moving on. Report findings back to the coordinator via Agent Mail with subject \`[review] <bead-id> self-review\`.\n\nFiles changed (all-wave, partition by bead before dispatch):\n${allArtifacts.map((a) => `- ${a}`).join("\n")}\n\nUse ultrathink.${callbackHint}${regressionHint}`,
                },
            ],
            details: { iterating: true, round, selfReview: true, preserveNtmPanes: true },
        };
    }
    if (chosen.startsWith("peers")) {
        const peerThreadId = `peer-review-r${round}`;
        const peerArtifacts = allArtifacts;
        const peerPreamble = (name) => st.coordinationBackend?.agentMail
            ? agentMailTaskPreamble(cwd, name, `Peer review round ${round}`, peerArtifacts, peerThreadId)
            : "";
        const peerAgents = [
            {
                name: `peer-bugs-r${round}`,
                task: `${peerPreamble(`peer-bugs-r${round}`)}Peer reviewer (round ${round}). Review code written by your fellow agents. Check for issues, bugs, errors, inefficiencies, security problems, reliability issues. Diagnose root causes using first-principle analysis. Don't restrict to latest commits - cast a wider net and go super deep!${memoryContext}\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}${domainReviewExtras}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\nUse ultrathink.\n\ncd ${cwd}`,
            },
            {
                name: `peer-polish-r${round}`,
                task: `${peerPreamble(`peer-polish-r${round}`)}Polish reviewer (round ${round}). De-slopify the code. Remove AI slop, improve clarity, make it agent-friendly.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\n${polish}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${cwd}`,
            },
            {
                name: `peer-ergonomics-r${round}`,
                task: `${peerPreamble(`peer-ergonomics-r${round}`)}Ergonomics reviewer (round ${round}). If you came in fresh with zero context, would you understand this code? Fix anything confusing.\n\nGoal: ${goal}\nFiles: ${allArtifacts.join(", ")}\n\nFix issues directly using the edit tool. Your changes persist to disk.\n\ncd ${cwd}`,
            },
            {
                name: `peer-reality-r${round}`,
                task: `${peerPreamble(`peer-reality-r${round}`)}Reality checker (round ${round}).\n\n${realityCheckInstructions(goal, activeBeads, beadResults)}\n\nDo NOT edit code. Just report findings.\n\ncd ${cwd}`,
            },
        ];
        const peerJson = JSON.stringify({ agents: peerAgents }, null, 2);
        return {
            content: [
                {
                    type: "text",
                    text: `**NEXT: Call \`parallel_subagents\` NOW with the config below.**\n\n## Peer Review - Round ${round}\n\n\`\`\`json\n${peerJson}\n\`\`\`\n\nAfter all complete, present findings and apply fixes. Then call \`flywheel_review\` with beadId "__gates__" and verdict "pass".${regressionHint}`,
                },
            ],
            details: { iterating: true, round, peerReview: true },
        };
    }
    if (chosen.startsWith("tests")) {
        const ubsAvailable = await detectUbs(exec, cwd);
        const ubsRequired = ubsAvailable
            ? `\n\n**Required:** Run \`ubs <changed-files>\` and fix ALL issues before calling flywheel_review.`
            : "";
        return {
            content: [
                {
                    type: "text",
                    text: `## Test Coverage Check - Round ${round}\n\nDo we have full unit test coverage without using mocks or fake stuff? What about complete e2e integration test scripts with great, detailed logging?\n\nReview the current state:\n- Goal: ${goal}\n- Files: ${allArtifacts.join(", ")}\n\nIf test coverage is incomplete, create specific tasks for each missing test, with subtasks and dependency structure. Each task should be self-contained - a fresh agent can execute it without extra context.\n\nFor unit tests: test real behavior, not mocked interfaces. For e2e: full integration scripts with detailed logging at each stage.${ubsRequired}${callbackHint}${regressionHint}`,
                },
            ],
            details: { iterating: true, round, testCoverage: true },
        };
    }
    if (chosen.startsWith("adversarial")) {
        // Adversarial reading: randomly select files and trace execution flows
        // to find bugs invisible to targeted self-review
        const shuffled = [...allArtifacts].sort(() => Math.random() - 0.5);
        const sampleSize = Math.min(shuffled.length, 5);
        const randomFiles = shuffled.slice(0, sampleSize);
        return {
            content: [{
                    type: "text",
                    text: `## Adversarial Code Exploration - Round ${round}

You are an adversarial reader. You do NOT know what was changed or why. Your job is to find bugs by tracing execution flows through randomly selected files.

**Randomly selected files to start from:**
${randomFiles.map(f => `- \`${f}\``).join("\n")}

**Instructions:**
1. For each file, pick a public function or entry point
2. Trace its execution path through the codebase — follow every call, check every branch
3. At each step, ask: "What happens if this input is null? Empty? Huge? Concurrent?"
4. Look for: missing error handling, race conditions, resource leaks, type mismatches, logic errors
5. Do NOT limit yourself to these files — follow the execution wherever it leads
6. Fix any bugs you find directly

**Key principle:** You are NOT reviewing changes. You are hunting bugs by reading code as an adversary who wants to break it. Cast a wide net.

Use ultrathink.${callbackHint}${regressionHint}`,
                }],
            details: { iterating: true, round, adversarialReading: true },
        };
    }
    if (chosen.startsWith("ubs")) {
        const ubsAvailable = await detectUbs(exec, cwd);
        if (!ubsAvailable) {
            return {
                content: [{ type: "text", text: `## UBS Scan - Round ${round}\n\nUBS not installed - skipping. Install with: \`cargo install ubs\` for future sessions.\n\nProceeding to commit gate.${callbackHint}` }],
                details: { iterating: true, round, ubsScan: true, skipped: true },
            };
        }
        const ubsResult = await resilientExec(exec, "ubs", allArtifacts, {
            cwd, timeout: 60_000, maxRetries: 0,
        });
        const ubsClean = ubsResult.ok;
        const ubsOutput = ubsResult.ok
            ? (ubsResult.value.stdout || ubsResult.value.stderr || "(no output)")
            : ("error" in ubsResult && ubsResult.error
                ? String(ubsResult.error.stdout || ubsResult.error.stderr || ubsResult.error)
                : "(no output)");
        const ubsSection = ubsClean
            ? `\n\n✅ **UBS scan passed** — no issues found.`
            : `\n\n❌ **UBS found issues — fix before committing:**\n\`\`\`\n${ubsOutput}\n\`\`\`\n\nFix all issues, then call \`flywheel_review\` with beadId "__gates__" and verdict "fail" to re-run this gate.`;
        return {
            content: [{
                    type: "text",
                    text: `## UBS Scan - Round ${round}${ubsSection}${callbackHint}${regressionHint}`,
                }],
            details: { iterating: true, round, ubsScan: true, ubsClean },
        };
    }
    if (chosen.startsWith("slop")) {
        // De-slopification gate: only triggers if doc files were modified
        const docFiles = allArtifacts.filter(f => f.endsWith(".md") || f.startsWith("docs/") || f.toLowerCase().includes("readme"));
        if (docFiles.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `## De-Slopify - Round ${round}\n\nNo documentation files were modified - skipping de-slopification.${callbackHint}`,
                    },
                ],
                details: { iterating: true, round, deSlopify: true, skipped: true },
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `## De-Slopify - Round ${round}\n\n${deSlopifyInstructions(docFiles)}${callbackHint}`,
                },
            ],
            details: { iterating: true, round, deSlopify: true },
        };
    }
    if (chosen.startsWith("commit")) {
        return {
            content: [
                {
                    type: "text",
                    text: `## Commit - Round ${round}\n\nBased on your knowledge of the project, commit all changed files now in a series of logically connected groupings with super detailed commit messages for each. Take your time to do it right.\n\nRules:\n- Group by logical change, NOT by file\n- Each commit should be independently understandable\n- Use conventional commit format: type(scope): description\n- First line <= 72 chars, then blank line, then detailed body\n- Body explains WHY, not just WHAT\n- Don't edit the code at all\n- Don't commit obviously ephemeral files\n- Push after committing\n\nUse ultrathink.${callbackHint}`,
                },
            ],
            details: { iterating: true, round, committing: true },
        };
    }
    if (chosen.startsWith("ship")) {
        return {
            content: [
                {
                    type: "text",
                    text: `## Ship It - Round ${round}\n\nDo all the GitHub stuff:\n1. **Commit** all remaining changes in logical groupings with detailed messages\n2. **Push** to remote\n3. **Create tag** with semantic version bump (based on changes: feat=minor, fix=patch)\n4. **Create GitHub release** with changelog from commits since last tag\n5. **Monitor CI** - check GitHub Actions status, wait for green\n6. **Compute checksums** if there are distributable artifacts\n7. **Bump version** in package.json if applicable\n\nDo each step and report status. If any step fails, stop and report why.${callbackHint}`,
                },
            ],
            details: { iterating: true, round, shipping: true },
        };
    }
    if (chosen.startsWith("land")) {
        return {
            content: [
                {
                    type: "text",
                    text: `## Landing Checklist - Round ${round}\n\n${landingChecklistInstructions(cwd)}${callbackHint}`,
                },
            ],
            details: { iterating: true, round, landing: true },
        };
    }
    // Unreachable: all gate choices are handled above.
    // If we get here something is wrong - return a safe fallback.
    return {
        content: [{ type: "text", text: `Unknown gate choice: "${chosen}". Call \`flywheel_review\` with beadId "__gates__" to continue.` }],
        details: { iterating: true, round, unknownGate: chosen },
    };
}
//# sourceMappingURL=gates.js.map