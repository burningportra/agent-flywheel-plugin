export type ToolUseRecord = {
  ts: string;
  turn: number;
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
};

export type TextRecord = {
  ts: string;
  turn: number;
  text: string;
};

export type ScenarioResult = {
  id: string;
  description: string;
  status: "pass" | "fail" | "skipped";
  reason?: string;
  violations: string[];
  turns: number;
  stop_reason?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  cost_usd?: number;
  tool_use_count: number;
  artifact_path: string;
  duration_ms: number;
  worktree?: string;
  brainstorm_path?: string;
};

export type BaselineReport = {
  version: 1;
  git_sha: string;
  git_dirty: boolean;
  recorded_at: string;
  model: string;
  claude_cli_version: string;
  scenarios: ScenarioResult[];
};

export type ScriptedAnswer = {
  headerContains: string;
  option: string;
};

export type ScenarioFacts = {
  toolUses: ToolUseRecord[];
  texts: TextRecord[];
};

export type Scenario = {
  id: string;
  description: string;
  goal: string;
  scripted: ScriptedAnswer[];
  assert: (facts: ScenarioFacts) => string[];
  maxTurns?: number;
  /**
   * Optional per-scenario fixture setup, invoked after the worktree is
   * built and the brainstorm is written but before the SDK session starts.
   * Lets a scenario pre-seed `.pi-flywheel/checkpoint.json` or a tiny
   * closed bead so the orchestrator can route straight into Step 9 /
   * wrap-up without the full plan + implement loop.
   */
  prepareFixtures?: (worktree: string) => Promise<void>;
};
