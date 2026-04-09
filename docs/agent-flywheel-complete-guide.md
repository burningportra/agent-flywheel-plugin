# The Complete Flywheel Guide - Agent-Based Software Development

Source: https://agent-flywheel.com/complete-guide
Downloaded: 2026-04-08

## Overview

This comprehensive guide presents "The Agentic Coding Flywheel," a methodology for creating software by orchestrating swarms of AI agents. Developed by Jeffrey Emanuel, the approach emphasizes exhaustive markdown planning, task management through "beads," and coordinated agent execution.

## Core Methodology: Nine-Step Workflow

The process follows this arc:

1. **Explain intent to frontier models** (GPT Pro with Extended Reasoning) to produce initial markdown plans
2. **Request competing plans** from multiple models (Claude Opus, Gemini, Grok Heavy)
3. **Synthesize best ideas** from competing plans into hybrid superior document
4. **Iterate relentlessly** across multiple refinement rounds until suggestions become incremental
5. **Convert plans to beads** - self-contained work units optimized for agent execution
6. **Polish beads obsessively** through 4-6+ review cycles checking for duplicates and missing dependencies
7. **Launch agent swarm** (Claude Code, Codex, Gemini-CLI) running in parallel coordinating through Agent Mail
8. **Tend the swarm** by checking stuck beads, rescuing agents after context compaction, and ensuring flow quality
9. **Agents review, test, harden** through multiple rounds of self-review, cross-agent review, and coverage testing

## Planning Dominates Implementation

The methodology allocates approximately 85% of effort to planning phases. This investment pays dividends because:

- **Context preservation**: A 6,000-line markdown plan remains vastly smaller than the resulting codebase, allowing models to reason holistically
- **Planning is cheapest**: Token costs for planning are far lower than implementation tokens, enabling many refinement rounds
- **System-wide consequences**: Each planning iteration evaluates global impact, not just local edits
- **Prevents improvisation**: With detailed plans and polished beads, agents execute constrained designs rather than inventing architecture while coding

## Three Reasoning Spaces

The methodology separates work into distinct layers:

**Plan Space**: Large markdown designs determining architecture, features, workflows, and tradeoffs (cost: 1x rework if errors caught here)

**Bead Space**: Self-contained work packets with context, dependencies, test obligations (cost: 5x rework if errors caught here)

**Code Space**: Implementation and verification in source files (cost: 25x rework if errors caught here)

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

Beads are executable memory - task graphs carrying enough local context that agents act correctly without repeatedly loading the full plan. Key characteristics:

- **Self-contained**: No need to reference original markdown plan
- **Rich content**: Long descriptions with embedded markdown
- **Complete coverage**: Everything from plan translates to beads
- **Explicit dependencies**: Correct dependency graph enables optimal routing
- **Testing included**: Comprehensive unit and e2e test scripts with detailed logging

For complex projects, expect 200-500 initial beads with full dependency structure. The CASS Memory System converted a 5,500-line plan into 347 beads.

## Bead Polishing: "Check N Times, Implement Once"

Before swarm execution, run 4-6+ polishing rounds using Claude Code with Opus, checking each bead for:

- Logical coherence and optimality
- Feature completeness (no oversimplification or loss of functionality)
- Comprehensive test coverage
- Duplicate elimination and dependency accuracy
- Cross-reference against markdown plan

Convergence indicators include shorter agent responses, decelerating change velocity, and increasing content similarity. When weighted convergence reaches 0.75+, proceed to implementation.

## The Coordination Stack

Three tools work as integrated system:

**Agent Mail**: High-bandwidth negotiation layer enabling targeted messaging and advisory file reservations with TTL expiry (preventing deadlocks from crashed agents)

**beads (br)**: Durable, localized task state stored as SQLite + JSONL hybrid files committing with code

**bv**: Graph-theory analysis tool computing PageRank, betweenness, HITS, and critical path metrics to guide agents toward optimal work

These three enable "fungible agents" - generalist replacements that can assume any bead without specialized roles or single points of failure.

## Key Operational Rules (AGENTS.md)

Every project requires a comprehensive operating manual specifying:

- Rule 0: Human instructions override everything
- Rule 1: Never delete files without explicit permission
- No destructive git commands (`git reset --hard`, `git clean -fd`, `rm -rf`)
- All work on `main` branch (single-branch model preventing merge hell)
- No file-deletion-based code changes; always manual modifications
- No file variants (`mainV2.rs`)
- Compiler verification after changes
- Multi-agent awareness: never stash, revert, or overwrite other agents' work

Post-compaction, agents must re-read AGENTS.md - the most common intervention prompt across all sessions.

## Swarm Launch & Operation

**Spawning**: Use ntm (Named Tmux Manager) or equivalent multiplexer to create multi-agent sessions:
```
ntm spawn myproject --cc=2 --cod=1 --gmi=1
```

**Initial marching orders**: Each agent reads AGENTS.md and README, understands codebase, registers with Agent Mail, checks messages, then claims work using bv prioritization.

**Staggering**: Launch agents 30+ seconds apart to prevent thundering herd synchronization and lock contention.

**Model composition** varies by phase:
- Planning: GPT Pro (Extended Reasoning)
- Implementation: Claude Code + Codex + Gemini (diverse swarm)
- Review: Claude Code + Gemini
- Final verification: Codex

Practical limits: ~12 agents per single project, or 5 agents across multiple projects. Ratio of --cc=2 --cod=1 --gmi=1 balances architectural reasoning (Claude), fast execution (Codex), and fresh perspectives (Gemini).

## Single-Branch Git Workflow

All agents commit directly to `main` with three conflict-prevention mechanisms:

1. **File reservations**: Advisory (not rigid) via Agent Mail with TTL expiry
2. **Pre-commit guard**: Blocks commits to files reserved by other agents
3. **DCG (Destructive Command Guard)**: Mechanically blocks dangerous commands

Recommended workflow: pull latest → reserve files → edit and test → commit immediately → push → release reservation.

## Code Review & Testing

Review happens continuously rather than as gate:

**Self-review after each bead**: "Fresh eyes" reading with ultrathink to catch obvious bugs and problems. Repeat until no more bugs found.

**Cross-agent review every 30-60 minutes**: Different agents review integration points, catching issues invisible to individual self-reviews.

**Random code exploration**: Agents sort through files tracing execution flows to find bugs through adversarial reading.

**Test coverage**: Agents create comprehensive unit and e2e test suites (beads can include BrennerBot with nearly 5,000 tests).

**UBS scanning**: Ultimate Bug Scanner catches errors beyond linters - security vulnerabilities, supply chain issues, runtime stability problems.

## UI/UX Polish Phase

Separate from bug hunting, this involves:

1. **Scrutiny pass**: Generate improvement suggestions (15-30 ideas)
2. **Human review**: Select which to pursue
3. **Bead conversion**: Turn selections into new work items
4. **Platform-specific polish**: Optimize separately for desktop and mobile
5. **De-slopification**: Remove AI writing patterns, improve documentation tone

## Case Study: CASS Memory System

Real-world example demonstrating methodology:

- **5,500-line markdown plan** synthesized from 4 frontier models
- **347 beads** with full dependency structure
- **11,000 lines of working code** produced by 25 agents
- **204 commits** completed in ~5 hours
- Public artifacts available: plan, agent mail messages, and beads

## When to Stop Planning and Start Implementation

Stay in plan refinement if:
- Whole-workflow questions still moving
- Major architecture debates remain open
- Fresh models find substantial missing features
- Tradeoffs being discovered

Switch to beads when:
- Plan feels mostly stable
- Improvements are about execution structure and testing
- Sequencing and embedded context questions dominate
- Product redesign is complete

## Critical Failure Patterns

**Plan-bead gap**: Plan revision completes but beads never created (requires explicit transition prompt)

**Vague beads**: Agents improvise architecture producing inconsistent implementations

**Missing dependencies**: Agents work on tasks whose prerequisites aren't done

**Thin AGENTS.md**: Agents produce non-idiomatic code

**Strategic drift**: Swarm produces code without closing goal gaps (run reality-check prompt and revise bead graph)

## Human Operator Role

Rather than managing code, operators manage the machine itself:

- Check bead progress every 10-30 minutes
- Force AGENTS.md re-reads after compactions
- Trigger periodic fresh-eyes reviews
- Manage rate limits via account switching
- Commit periodically (every 1-2 hours)
- Create new beads for unanticipated issues

Success means designing an intricate machine, launching it, and returning later to substantial completed work.

---

This methodology represents a fundamental shift: from writing code directly to designing systems where AI agents execute highly detailed plans, coordinate through specialized tools, and continuously review their own work while humans focus on high-level design and orchestration.
