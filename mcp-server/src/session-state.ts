/**
 * Session-state detection and resumption helpers.
 *
 * Determines which flywheel stage the user is in — even after a cold
 * session restart where `oc.state.phase` may have been reset to "idle" —
 * by cross-checking the persisted state against on-disk evidence:
 *   • bead statuses from `br list`
 *   • presence of a plan artifact
 *   • presence of a repo profile
 *
 * The result is a rich `SessionStage` that:
 *   - labels the phase in plain language
 *   - summarises what was completed vs. what remains
 *   - provides the exact follow-up message to resume from that stage
 *   - rates its own confidence (high / medium / low)
 */

import type { FlywheelPhase, FlywheelState, Bead } from "./types.js";

// ─── Public types ─────────────────────────────────────────────

export interface SessionStage {
  /** Resolved phase — may be inferred rather than taken verbatim from state. */
  phase: FlywheelPhase;
  /** Short, human-readable phase title. */
  label: string;
  /** Leading emoji for the phase (used in UI labels). */
  emoji: string;
  /** Goal the user was pursuing, if known. */
  goal?: string;
  /** Artifact path for the plan document, if one exists. */
  planDocument?: string;
  /** Bead ID that was in-progress when the session ended, if any. */
  currentBeadId?: string;
  /** Number of beads that are open or in-progress. */
  openBeadCount: number;
  /** Number of beads that have been closed (completed). */
  completedBeadCount: number;
  /** Total beads tracked (open + in-progress + closed + deferred). */
  totalBeadCount: number;
  /** One-line "what to do next" hint for the menu prompt. */
  nextAction: string;
  /** Full follow-up message to send to the agent when the user picks Resume. */
  resumePrompt: string;
  /**
   * How confident the detection is.
   * "high"   → taken directly from a non-idle persisted phase.
   * "medium" → inferred from on-disk bead/plan evidence.
   * "low"    → best-guess from partial signals only.
   */
  confidence: "high" | "medium" | "low";
  /** Human-readable list of signals used to reach this conclusion. */
  inferredFrom: string[];
}

// ─── Phase metadata ───────────────────────────────────────────

interface PhaseMeta {
  label: string;
  emoji: string;
  nextAction: string;
  buildResumePrompt: (stage: Omit<SessionStage, "resumePrompt">) => string;
}

const PHASE_META: Record<FlywheelPhase, PhaseMeta> = {
  idle: {
    label: "Idle",
    emoji: "💤",
    nextAction: "Run /start to start.",
    buildResumePrompt: () => "Start the flywheel workflow. Call `flywheel_profile` to scan the repo.",
  },
  profiling: {
    label: "Scanning repo",
    emoji: "🔍",
    nextAction: "Call `flywheel_profile` to continue.",
    buildResumePrompt: () => "Resuming flywheel. Call `flywheel_profile` to continue scanning the repository.",
  },
  discovering: {
    label: "Generating ideas",
    emoji: "💡",
    nextAction: "Call `flywheel_discover` to continue.",
    buildResumePrompt: (s) =>
      `Resuming flywheel${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
      `Call \`flywheel_discover\` to continue generating ideas.`,
  },
  awaiting_selection: {
    label: "Awaiting goal selection",
    emoji: "🎯",
    nextAction: "Call `flywheel_select` to pick a goal.",
    buildResumePrompt: () => "Resuming flywheel. Call `flywheel_select` to pick a goal and proceed.",
  },
  planning: {
    label: "Writing plan",
    emoji: "📝",
    nextAction: "Call `flywheel_plan` to continue.",
    buildResumePrompt: (s) =>
      `Resuming flywheel${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
      `Call \`flywheel_plan\` to continue or re-generate the plan.`,
  },
  researching: {
    label: "Researching external project",
    emoji: "🔭",
    nextAction: "Rerun `/flywheel-research <url>` to resume from the last completed phase.",
    buildResumePrompt: (s) =>
      `Research pipeline was interrupted${s.goal ? ` (goal: "${s.goal}")` : ""}. ` +
      `Rerun \`/flywheel-research\` with the same URL to resume from the last completed phase. ` +
      `Progress is saved — completed phases will be skipped.`,
  },
  awaiting_plan_approval: {
    label: "Plan ready — awaiting approval",
    emoji: "📋",
    nextAction: "Call `flywheel_approve_beads` to review and approve.",
    buildResumePrompt: (s) =>
      `Resuming flywheel${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
      `A plan is ready${s.planDocument ? ` at \`${s.planDocument}\`` : ""}. ` +
      `Call \`flywheel_approve_beads\` to review it and stay inside the plan approval → bead creation workflow.`,
  },
  creating_beads: {
    label: "Creating beads",
    emoji: "🔩",
    nextAction: "Call `flywheel_approve_beads` when all beads are created.",
    buildResumePrompt: (s) =>
      s.openBeadCount > 0
        ? `Resuming flywheel${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
          `${s.openBeadCount} bead(s) already created. Call \`flywheel_approve_beads\` to review and approve them inside the workflow menus.`
        : `Resuming flywheel${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
          `Continue creating beads with \`br create\`, then call \`flywheel_approve_beads\` when done to re-enter the approval menu.`,
  },
  refining_beads: {
    label: "Refining beads",
    emoji: "🔧",
    nextAction: "Continue refining beads.",
    buildResumePrompt: (s) =>
      `Resuming bead refinement${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
      `Call \`flywheel_approve_beads\` to check quality and continue inside the approval workflow.`,
  },
  awaiting_bead_approval: {
    label: "Beads ready — awaiting approval",
    emoji: "✅",
    nextAction: "Call `flywheel_approve_beads` to approve.",
    buildResumePrompt: (s) =>
      `Resuming flywheel${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
      `${s.openBeadCount} bead(s) are ready for approval. Call \`flywheel_approve_beads\` to review them and stay inside the workflow menus.`,
  },
  implementing: {
    label: "Implementing",
    emoji: "⚙️",
    nextAction: "Call `flywheel_review` to pick up the next bead.",
    buildResumePrompt: (s) => {
      const progress = s.totalBeadCount > 0
        ? ` (${s.completedBeadCount}/${s.totalBeadCount} done)`
        : "";
      const current = s.currentBeadId
        ? ` Bead **${s.currentBeadId}** was in-progress.`
        : "";
      return (
        `Resuming implementation${s.goal ? ` for goal: "${s.goal}"` : ""}${progress}.${current} ` +
        `Call \`flywheel_review\` to check bead status and continue inside the implementation/review workflow.`
      );
    },
  },
  reviewing: {
    label: "Reviewing implementation",
    emoji: "🔬",
    nextAction: "Call `flywheel_review` to continue.",
    buildResumePrompt: (s) =>
      `Resuming review${s.goal ? ` for goal: "${s.goal}"` : ""}. ` +
      `Call \`flywheel_review\` to continue the review process inside the workflow menus.`,
  },
  iterating: {
    label: "Iterating on feedback",
    emoji: "🔄",
    nextAction: "Call `flywheel_review` to continue.",
    buildResumePrompt: (s) => {
      const progress = s.totalBeadCount > 0
        ? ` (${s.completedBeadCount}/${s.totalBeadCount} done)`
        : "";
      return (
        `Resuming iteration${s.goal ? ` for goal: "${s.goal}"` : ""}${progress}. ` +
        `Call \`flywheel_review\` to continue iterating on feedback inside the workflow menus.`
      );
    },
  },
  complete: {
    label: "Complete",
    emoji: "🎉",
    nextAction: "All done! Run /start to start a new session.",
    buildResumePrompt: () => "Previous flywheel was complete. Starting fresh — call `flywheel_profile` to scan the repo.",
  },
};

// ─── Core detection logic ─────────────────────────────────────

/**
 * Detect the current flywheel stage from persisted state + live bead data.
 *
 * Resolution order:
 * 1. If `state.phase` is a concrete non-idle phase → use it (confidence: "high")
 * 2. Else, infer from on-disk evidence:
 *    a. in-progress beads → implementing
 *    b. open beads + plan doc → awaiting_bead_approval / implementing
 *    c. open beads, no plan doc → implementing
 *    d. repoProfile but no beads → discovering
 *    e. nothing → idle
 */
export function detectSessionStage(
  state: FlywheelState,
  beads: Bead[]
): SessionStage {
  const inferredFrom: string[] = [];
  let phase = state.phase;
  let confidence: SessionStage["confidence"] = "high";

  const openBeads = beads.filter(b => b.status === "open" || b.status === "in_progress");
  const completedBeads = beads.filter(b => b.status === "closed");
  const inProgressBeads = beads.filter(b => b.status === "in_progress");
  const openBeadCount = openBeads.length;
  const completedBeadCount = completedBeads.length;
  const totalBeadCount = beads.length;

  // ── Step 1: if we have a concrete persisted phase, trust it ──
  // Special case: if researchState exists with incomplete phases, that takes
  // priority over a stale idle/complete phase.
  if ((phase === "idle" || phase === "complete") && (state as any).researchState?.phasesCompleted?.length > 0) {
    const rs = (state as any).researchState as { url: string; externalName: string; artifactName: string; phasesCompleted: string[] };
    const totalPhases = 7;
    if (rs.phasesCompleted.length < totalPhases) {
      phase = "researching";
      confidence = "medium";
      inferredFrom.push(`research in-progress for "${rs.externalName}" (${rs.phasesCompleted.length}/${totalPhases} phases done)`);
    }
  }

  if (phase !== "idle" && phase !== "complete") {
    if (!inferredFrom.some(s => s.includes("research"))) {
      inferredFrom.push(`persisted phase "${phase}"`);
    }
  } else {
    // ── Step 2: infer from on-disk evidence ──
    confidence = "medium";

    if (inProgressBeads.length > 0) {
      phase = "implementing";
      inferredFrom.push(`${inProgressBeads.length} in-progress bead(s) found on disk`);
    } else if (openBeads.length > 0 && state.planDocument) {
      phase = "implementing";
      inferredFrom.push(`${openBeads.length} open bead(s) + plan document "${state.planDocument}"`);
    } else if (openBeads.length > 0) {
      phase = "implementing";
      inferredFrom.push(`${openBeads.length} open bead(s) found on disk`);
    } else if (completedBeads.length > 0) {
      // All beads done — treat as complete
      phase = "complete";
      inferredFrom.push(`${completedBeads.length} completed bead(s), none open`);
    } else if (state.repoProfile) {
      phase = "discovering";
      confidence = "low";
      inferredFrom.push("repo profile present, no beads created yet");
    } else if (state.planDocument) {
      phase = "awaiting_plan_approval";
      confidence = "low";
      inferredFrom.push(`plan document "${state.planDocument}" exists but no beads`);
    } else {
      // Nothing to go on
      phase = "idle";
      confidence = "low";
      inferredFrom.push("no persistent signals found");
    }
  }

  const meta = PHASE_META[phase];
  const currentBeadId = inProgressBeads[0]?.id ?? state.currentBeadId ?? undefined;

  const stageWithoutPrompt: Omit<SessionStage, "resumePrompt"> = {
    phase,
    label: meta.label,
    emoji: meta.emoji,
    goal: state.selectedGoal,
    planDocument: state.planDocument,
    currentBeadId,
    openBeadCount,
    completedBeadCount,
    totalBeadCount,
    nextAction: meta.nextAction,
    confidence,
    inferredFrom,
  };

  return {
    ...stageWithoutPrompt,
    resumePrompt: meta.buildResumePrompt(stageWithoutPrompt),
  };
}

// ─── Formatting helpers ───────────────────────────────────────

/**
 * Builds the multi-line header string shown inside the `/start` select
 * prompt when an existing session is detected.
 *
 * Example output:
 * ```
 * ⚙️ Phase:     Implementing (3/8 beads done)
 * 🎯 Goal:      Add dark mode support
 * 🔩 Current:   br-5 "Update CSS variables…" (in-progress)
 * 📋 Plan:      research/dark-mode-proposal.md
 * 🔎 Detected:  persisted phase "implementing" (high confidence)
 * ```
 */
export function formatSessionContext(stage: SessionStage, currentBeadTitle?: string): string {
  const lines: string[] = [];

  // Phase line
  const progressStr = stage.totalBeadCount > 0
    ? ` (${stage.completedBeadCount}/${stage.totalBeadCount} beads done)`
    : stage.openBeadCount > 0
    ? ` (${stage.openBeadCount} open)`
    : "";
  lines.push(`${stage.emoji} Phase:    ${stage.label}${progressStr}`);

  // Goal
  if (stage.goal) {
    const truncated = stage.goal.length > 72 ? stage.goal.slice(0, 69) + "..." : stage.goal;
    lines.push(`🎯 Goal:     ${truncated}`);
  }

  // Current bead
  if (stage.currentBeadId) {
    const titlePart = currentBeadTitle
      ? ` "${currentBeadTitle.length > 50 ? currentBeadTitle.slice(0, 47) + "..." : currentBeadTitle}"`
      : "";
    lines.push(`🔩 Current:  ${stage.currentBeadId}${titlePart} (in-progress)`);
  }

  // Plan document
  if (stage.planDocument) {
    lines.push(`📋 Plan:     ${stage.planDocument}`);
  }

  // Confidence + signals (shown as a subtle hint)
  const confidenceEmoji = stage.confidence === "high" ? "🟢" : stage.confidence === "medium" ? "🟡" : "🔴";
  lines.push(`${confidenceEmoji} Detected:  ${stage.inferredFrom.join(", ")} (${stage.confidence} confidence)`);

  return lines.join("\n");
}

/**
 * Builds the label for the "Resume" menu option, adapted to the current stage.
 * e.g. "📂 Resume implementing — br-5 in-progress, 2 more queued"
 */
export function buildResumeLabel(stage: SessionStage): string {
  if (stage.phase === "idle" || stage.phase === "complete") {
    return "📂 Resume — start fresh (no active session to resume)";
  }

  const parts: string[] = [];

  if (stage.phase === "implementing" || stage.phase === "reviewing" || stage.phase === "iterating") {
    if (stage.currentBeadId) {
      parts.push(`${stage.currentBeadId} in-progress`);
    }
    const queued = stage.openBeadCount - (stage.currentBeadId ? 1 : 0);
    if (queued > 0) parts.push(`${queued} more queued`);
  } else if (stage.phase === "awaiting_plan_approval" || stage.phase === "awaiting_bead_approval") {
    parts.push(`${stage.openBeadCount} bead(s) awaiting approval`);
  } else if (stage.phase === "creating_beads") {
    if (stage.openBeadCount > 0) {
      parts.push(`${stage.openBeadCount} bead(s) ready — call \`flywheel_approve_beads\``);
    } else {
      parts.push("beads in progress");
    }
  } else if (stage.phase === "planning") {
    if (stage.planDocument) parts.push(`plan: ${stage.planDocument}`);
  }

  const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `📂 Resume ${stage.label.toLowerCase()}${detail}`;
}
