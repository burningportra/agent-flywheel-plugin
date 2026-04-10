# The Complete Flywheel Guide - Agent-Based Software Development

Source: https://agent-flywheel.com/complete-guide
Downloaded: 2026-04-09

## Overview

The Agent Flywheel is a methodology for orchestrating swarms of AI agents to build software through exhaustive planning, task management via "beads," and coordinated execution. Created by Jeffrey Emanuel, it emphasizes front-loading cognitive work into planning phases where reasoning is cheapest and most global.

## Core Methodology: Nine-Step Workflow

1. **Explain your vision** to frontier models like GPT Pro with Extended Reasoning
2. **Gather competing plans** from multiple models independently
3. **Synthesize superior hybrid plans** combining each model's strengths
4. **Iterate relentlessly** across fresh conversations until improvements plateau
5. **Convert plans to beads** (self-contained work units with dependencies)
6. **Polish beads obsessively** through 4-6+ refinement rounds
7. **Launch coordinated agent swarms** using Claude Code, Codex, and Gemini
8. **Tend the swarm** by monitoring progress and rescuing stuck agents
9. **Review, test, and harden** through multiple verification rounds

## Planning Philosophy

The methodology inverts typical development: spend 85% of effort on planning before any implementation begins. Planning tokens are far fewer and cheaper than implementation tokens, making this the optimal layer for global reasoning and architectural decisions.

Key advantages of detailed planning:

- **Whole-system reasoning**: Markdown plans (3,000-6,000 lines) remain small enough to fit entirely in context windows
- **Cheap corrections**: Fixing architecture in plan-space costs 1x rework; in code-space, it costs 25x
- **Emergent requirements**: Multi-model feedback surfaces edge cases and workflows you wouldn't discover alone
- **Distributed cognition**: Competing models find different blind spots; synthesis produces hybrid approaches stronger than any individual plan

## Three Reasoning Spaces

**Plan Space** (Primary Artifact: Markdown document)
- Focuses on architecture, features, workflows, and tradeoffs
- All decisions still fit in context; global reasoning is possible
- Cost of error: 1x (pure reasoning, zero code churn)

**Bead Space** (Primary Artifact: Dependency graph of work units)
- Translates plans into executable memory for agents
- Self-contained tasks with embedded context, dependencies, and test obligations
- Cost of error: 5x (requires reorchestration of execution packets)

**Code Space** (Primary Artifact: Source files and tests)
- Implementation and local verification within constrained architecture
- High-level decisions already made; agents execute rather than design
- Cost of error: 25x (pays both implementation and cleanup taxes)

This hierarchy reflects the "Law of Rework Escalation" - catching mistakes early minimizes downstream restructuring costs.

## Markdown Plans: Content & Refinement

Effective plans spell out user-visible systems with concrete workflows rather than vague concepts. For example, instead of "build a notes app," plans describe:

"Users upload Markdown files through drag-and-drop UI. System parses frontmatter tags and stores upload failures for review. Search supports keyword, tag, and date filtering with low perceived latency."

Plans typically reach 3,000-6,000+ lines through iterative refinement. The process involves:

1. Fresh conversations with GPT Pro (each round prevents model anchoring)
2. Specific revision prompts requesting git-diff style changes with detailed rationale
3. Integration of revisions by Claude Code with critical assessment
4. Multi-model synthesis combining Claude, GPT, Gemini, and Grok competing proposals

## Converting Plans to Beads

Beads are units of work optimized for agent execution, stored as JSONL in `.beads/` directories. Each bead must be:

- **Self-contained**: Never requires reopening the original plan
- **Context-rich**: Includes markdown descriptions with background, reasoning, and considerations
- **Complete**: All plan details transfer into beads
- **Dependency-explicit**: Full graphs enabling optimal execution ordering
- **Test-inclusive**: Unit tests and e2e scripts with detailed logging

Sample bead types for an Atlas Notes application:

- **br-101 Upload and Parse Pipeline**: File format acceptance, frontmatter parsing, error handling, test coverage
- **br-102 Search Index and Query UX**: Search behavior, indexing rules, latency expectations, filter semantics
- **br-103 Ingestion Failure Dashboard**: Admin workflows, permissions, retry logic, operational visibility

Complex projects typically produce 200-500 initial beads. The CASS Memory System (5,500-line plan) yielded 347 beads that agents converted into 11,000 lines of production code in ~5 hours.

## Bead Polishing Strategy

Before implementing, run 4-6+ polishing rounds using this progression:

**Rounds 1-3**: Major structural changes (duplicate detection, missing dependencies, feature gaps)
**Rounds 4-7**: Interface refinements and boundary adjustments
**Rounds 8-12**: Edge cases and nuanced handling
**Rounds 13+**: Convergence to steady-state

Stop when weighted convergence metrics (dependency stabilization, content similarity, output length, semantic density) reach 0.75+ confidence. Use fresh Claude Code sessions when improvements plateau, as new sessions avoid accumulated assumptions.

## Coordination Infrastructure

Three interlocking systems enable swarm determinism:

**Beads (br tool)**
- Durable, localized issue state
- Agents claim beads via status updates
- Dependency graph guides execution ordering

**Agent Mail**
- High-bandwidth negotiation layer between agents
- Advisory file reservations with TTL expiry (survives agent crashes)
- Named agents ("ScarletCave," "CoralBadger") with semi-persistent identity
- Thread anchors via bead IDs for audit trails

**bv (Graph-Theory Router)**
- Precomputes PageRank, betweenness, HITS, eigenvector, critical path
- Commands: `--robot-triage` (full recommendations), `--robot-next` (single pick), `--robot-plan` (parallel tracks)
- Agents query deterministically for dependency-aware prioritization

## AGENTS.md: The Operating Manual

A critical project file containing:

1. Override prerogative (human instructions trump everything)
2. Safety constraints (no destructive git commands, no file deletion)
3. Branching policy (all work on `main`, never worktrees)
4. Tool documentation and best practices
5. Project-specific conventions and coordination rules

After any context compaction, agents must re-read AGENTS.md immediately. This single intervention is the most common post-compaction reset.

## Single-Branch Git Model

All agents commit directly to `main`. This prevents:

- Merge complexity with 10+ concurrent agents
- Filesystem confusion from worktrees
- Context loss during branch switching
- Logical conflicts (function signature + new callsite merging cleanly but failing to compile)

Three mechanisms prevent conflicts:

1. **File reservations** (advisory, TTL-expiring, non-rigid)
2. **Pre-commit guards** (blocks commits to files reserved by others)
3. **DCG (Destructive Command Guard)** (mechanically blocks dangerous commands like `git reset --hard`)

Recommended workflow: pull latest -> reserve files -> edit/test -> commit immediately -> push -> release reservation.

## Agent Fungibility

Every agent is a generalist reading the same AGENTS.md and capable of claiming any bead. No role specialization; no "boss" coordinating agent. This design:

- Eliminates single points of failure
- Makes agent crashes survivable (bead remains `in_progress` for any agent to resume)
- Enables commodity-like instantiation/destruction
- Mirrors RaptorQ fountain codes: any agent catches any bead in any order

## Launching the Swarm

### Session Management Tools

- **ntm** (Named Tmux Manager): `ntm spawn project --cc=2 --cod=1 --gmi=1`
- **WezTerm**: Native mux with persistent remote sessions
- **Zellij/Ghostty**: Alternative multiplexers with comparable capabilities

### Recommended Composition

For most projects:
- 2 Claude Code sessions (architecture, complex reasoning)
- 1 Codex session (fast iteration, testing)
- 1 Gemini session (alternative perspective, review duty)

Practical limits: ~12 agents per single project, or 5 agents across multiple projects. Ratio of --cc=2 --cod=1 --gmi=1 balances architectural reasoning (Claude), fast execution (Codex), and fresh perspectives (Gemini).

### Staggering

Launch agents 30+ seconds apart to avoid thundering herd (simultaneous contention for frontier beads). Send marching orders prompt after 4-second delay.

### Swarm Marching Orders Prompt

The canonical prompt: "First read ALL of AGENTS.md and README.md... Then register with MCP Agent Mail... check bead progress... use bv to prioritize... Don't get stuck in communication purgatory... Use ultrathink."

This prompt is deliberately generic; specificity comes from beads and AGENTS.md rather than custom prompts per project.

## Code Review and Testing

### Self-Review After Each Bead

"Carefully read over all code you just wrote with fresh eyes... fix anything you uncover. Use ultrathink."

Run until no more bugs surface. Typically 1-2 rounds for simple beads, 2-3 for complex ones.

### Cross-Agent Review (every 30-60 minutes)

Two complementary prompts activate different search behaviors:
- **Random Code Exploration**: Trace execution flows; hunt obvious bugs
- **Critical Audit**: Seek architectural inconsistencies and integration issues

Alternate prompts until consecutive rounds surface no changes.

### Testing as Free Labor

Let agents write and maintain test suites while others implement. Larger projects (BrennerBot) reach ~5,000 tests with agents keeping them current as code changes. Use UBS (Ultimate Bug Scanner) as a pre-commit quality gate.

## UI/UX Polish Phase

Distinct from bug-hunting; occurs after core functionality works.

**Step 1 - Scrutiny Pass**: Generate 15-30 improvement suggestions (not code)
**Step 2 - Human Review**: Pick which suggestions to pursue
**Step 3 - Bead Creation**: Turn selections into formal tasks
**Step 4 - Platform-Specific Polish**: Separate desktop and mobile optimization
**Step 5 - Repeat**: Continue 2-3 rounds until marginal gains

## Adding Features to Existing Projects

### Idea-Wizard (6-phase pipeline)

1. Ground in reality (read AGENTS.md, list existing beads)
2. Generate 30 ideas, winnow to 5 best
3. Expand to 15 ideas (checking novelty against existing beads)
4. Human review and selection
5. Turn selected ideas into beads
6. Refine 4-5 times (standard polishing loop)

### Major Feature Integration (study + reimagine approach)

1. Investigate external project solving related problem
2. Propose integration via dedicated document
3. Deepen iteratively (push past conservative initial suggestions)
4. Invert analysis (find what you can do that they cannot)
5. Run 5x repeated blunder hunts after each expansion
6. Close design gaps explicitly
7. Make proposal self-contained for cross-model review
8. Get feedback from 4 frontier models independently
9. Synthesize via "best of all worlds" approach
10. Apply diffs and de-slopify

## Multi-Model Planning Pipeline

### Model Assignments

- **GPT Pro** (web): Initial planning, synthesis arbiter
- **Claude Opus** (web): Implementation realism, structural edits
- **Gemini Deep Think**: Alternative framings, missed edge cases
- **Grok Heavy**: Counterintuitive options, assumption pressure-testing

### Best-of-All-Worlds Synthesis

The synthesis prompt forces intellectual honesty about competitor strengths before synthesis: "Analyze competing plans honestly... come up with best revisions blending strongest ideas... provide git-diff style changes..."

### Fresh-Round Refinement

Run 4-5 rounds in fresh GPT Pro conversations (prevents model anchoring). Each round asks for careful review, best revisions, detailed analysis and rationale, in git-diff format with ultrathink.

Plans typically reach 3,000-6,000+ lines through this iterative deepening.

## Human Role in Agent-Driven Development

The human is **not** a code-writer or debugger in this model. Instead:

- **Design the system** (planning phase)
- **Polish executable memory** (bead refinement)
- **Set the swarm running** (marching orders)
- **Tend the machine** (monitoring, intervention, strategic course-correction)

On a 10-30 minute cadence:

1. Check bead progress (`br list --status in_progress`)
2. Handle compactions ("Reread AGENTS.md")
3. Run periodic reviews (fresh eyes prompts)
4. Manage rate limits (account switching via CAAM)
5. Commit periodically (organized commit rounds)
6. Catch strategic drift (reality check prompts)

Success means designing an intricate machine, launching it, and returning later to substantial completed work.

## Performance Metrics

### CASS Memory System Example

- 5,500-line markdown plan
- Synthesized from 4 frontier models
- 347 beads with full dependency structure
- 25 agents running in parallel
- 11,000 lines of working, tested code
- 204 commits
- **~5 hours to ship**

Success depends entirely on plan and bead quality. Once those artifacts are excellent, implementation becomes mechanical machine-tending.

## Critical Success Factors

- Spend 85% of effort on planning (not implementation)
- Use fresh conversations for each refinement round
- Convert plans completely to beads (nothing lost in translation)
- Polish beads 4-6+ times before implementation
- Stagger agent starts to avoid thundering herd
- Use Agent Mail and file reservations religiously
- Maintain excellent AGENTS.md documentation
- Trigger cross-agent reviews every 30-60 minutes
- Watch for strategic drift (busy does not equal progress toward goal)

## Critical Failure Patterns

- **Weak foundations**: Leak uncertainty downstream through all phases
- **Skipping multi-model feedback**: Produces weaker plans with blind spots
- **Early bead freezing**: Prevents discovery of critical issues
- **Plan-bead gap**: Plan revision completes but beads never created (requires explicit transition prompt)
- **Vague beads**: Agents improvise architecture producing inconsistent implementations
- **Missing dependencies**: Agents work on tasks whose prerequisites aren't done
- **Thin AGENTS.md**: Agents produce non-idiomatic code; chaos after compaction
- **Synchronous agent starts**: Thundering herd contention on frontier beads
- **Strategic drift**: Lots of commits but goal still distant (run reality-check prompt and revise bead graph)
- **Single agent role specialization**: Creates bottlenecks and single points of failure

## Key Takeaways

The Agentic Coding Flywheel inverts traditional development by treating planning as the primary cognitive investment. By keeping entire systems legible within model context windows during planning, by synthesizing competing models' strengths, and by converting that planning into richly-detailed executable memory (beads), the methodology enables swarms of agents to produce production-quality code in hours rather than weeks.

The compounding return comes from each cycle: better beads produce cleaner implementation, which uncovers remaining issues faster, which feed back into refined planning for the next feature cycle. The human becomes the architect and orchestrator rather than the builder.
