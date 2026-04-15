---
name: ubs-workflow
display_name: UBS Code Review Workflow
description: >-
  Comprehensive code review workflow using Ultimate Bug Scanner (UBS).
  Use when reviewing code, scanning for bugs, validating AI-generated code,
  or running pre-commit quality checks.
triggers:
  - review code
  - scan for bugs
  - code review
  - ubs
  - find bugs
  - security audit
version: 1.2.0
author: jeffrey
category: code-review
tags:
  - lang-typescript
  - lang-python
  - lang-rust
  - lang-go
  - ctx-cli
  - tool-docker
difficulty: intermediate
---

# UBS Code Review Workflow

Comprehensive code review methodology using the **Ultimate Bug Scanner (UBS)** tool. This workflow helps you catch bugs that compile but crash: null derefs, missing await, resource leaks, and security holes.

## Prerequisites

- `ubs` installed via `cargo install ubs` or from [agent-flywheel.com](https://agent-flywheel.com)
- A project with supported language files (Rust, Go, TypeScript, Python, etc.)

## The Golden Rule

```
ubs <changed-files> before every commit.
Exit 0 = safe to proceed.
Exit 1 = triage findings.
Exit 2 = run `ubs doctor --fix`.
```

---

## Workflow Steps

### Step 1: Initial Scan

Run UBS on your changed files or project:

**For staged files (pre-commit):**

```bash
ubs --staged
```

**For working tree changes:**

```bash
ubs --diff
```

**For full project scan:**

```bash
ubs .
```

**Language-specific scans:**

```bash
# TypeScript/JavaScript (note: --only=js excludes TS!)
ubs --only=ts,tsx src/

# Rust
ubs --only=rust src/

# Python
ubs --only=py src/

# Go
ubs --only=go cmd/ internal/
```

**Output to JSON for processing:**

```bash
ubs . --format=jsonl > ubs-results.jsonl
```

### Step 2: Triage Findings

UBS may report false positives. Apply this decision tree:

```
Finding → Code path executes? → No → FALSE POSITIVE (dead code)
                             → Yes ↓
         Guard clause exists? → Yes → FALSE POSITIVE (ubs:ignore)
                             → No ↓
         Validated elsewhere? → Yes → FALSE POSITIVE (cross-file)
                             → No → REAL BUG, fix it
```

**Prioritize by severity:**

| Blocks Commit      | Blocks PR            | Discuss in PR         |
| ------------------ | -------------------- | --------------------- |
| Null safety (1)    | Error swallowing (8) | Debug code (11)       |
| Security (2)       | Division by zero (6) | TODO markers (12)     |
| Missing await (3)  | Promise no catch (9) | TypeScript `any` (13) |
| Resource leaks (4) | Array mutation (10)  | Deep nesting (14)     |

### Step 3: Generate Fix Plan

For each real finding, document:

1. **Root cause analysis** - Why does this bug exist?
2. **Recommended fix** - Code snippet showing the solution
3. **Test case** - How to verify the fix works
4. **Effort estimate** - trivial / small / medium / large

Use the fix template in `templates/fix-template.md`.

### Step 4: Apply Fixes Safely

For each fix:

```bash
# 1. Apply the fix
# 2. Run relevant tests
npm test  # or cargo test, pytest, etc.

# 3. Re-scan to verify
ubs --staged

# 4. Commit with finding reference
git commit -m "fix: null check in user.profile access

Addresses UBS finding #1 (null safety)
- Added optional chaining for profile access
- Added unit test for null user case"
```

### Step 5: Suppress False Positives

When you've verified code is safe, add a suppression comment with justification:

```typescript
// GOOD - explains why it's safe
eval(trustedConfig); // ubs:ignore - internal config validated at startup

// BAD - no justification
eval(config); // ubs:ignore
```

**Per-language comment styles:**

| Language           | Suppression Format       |
| ------------------ | ------------------------ |
| JS/TS/Go/Rust/Java | `// ubs:ignore - reason` |
| Python/Ruby/Shell  | `# ubs:ignore - reason`  |
| SQL                | `-- ubs:ignore - reason` |

---

## Quick Reference

```bash
# Core workflow
ubs --staged                       # Staged files only (<1s)
ubs --diff                         # Working tree changes vs HEAD
ubs .                              # Full project scan

# Noise reduction
ubs --skip=11,12 .                 # Skip TODO/debug categories
ubs --profile=loose .              # Skip minor nits

# Output formats
ubs . --format=jsonl               # Per-finding details
ubs . --format=sarif > results.sarif  # IDE/GitHub integration

# PR review (new issues only)
ubs . --comparison=baseline.json --fail-on-warning

# Troubleshooting
ubs doctor                         # Check environment
ubs doctor --fix                   # Auto-fix issues
```

---

## Common Bug Patterns

UBS catches these patterns that often slip through compilation:

| Pattern             | Bug             | Category           |
| ------------------- | --------------- | ------------------ |
| `user.profile.name` | No null check   | 1 (Null safety)    |
| `fetch(url)`        | Missing await   | 3 (Async)          |
| `open(file)`        | Never closed    | 4 (Resource)       |
| `catch (e) {}`      | Swallowed error | 8 (Error handling) |

---

## AI Code Validation

AI-generated code is particularly prone to these issues. After any AI generates code:

```bash
ubs [file] --fail-on-warning
```

Review each finding carefully - AI often generates plausible-looking code that misses edge cases.

---

## Integration with bv (Optional)

Export UBS findings to the beads issue tracker:

```bash
ubs scan --format bv | bv import --tag ubs-review
```

This creates trackable beads for each finding, integrating code review into your project management workflow.

---

## Troubleshooting

| Problem              | Cause                     | Fix                             |
| -------------------- | ------------------------- | ------------------------------- |
| Exit code 2          | Missing optional scanners | `ubs doctor --fix`              |
| JS/TS degraded       | AST engine missing        | `ubs doctor --fix`              |
| Too many findings    | Legacy code               | Use `--comparison` for baseline |
| Too slow             | Full scan                 | Use `--staged` or `--only=`     |
| False positive storm | Test fixtures             | Add to `.ubsignore`             |

---

## Next Steps

After completing this workflow:

1. Set up a pre-commit hook: `ubs --staged --fail-on-warning`
2. Add UBS to CI: `ubs . --comparison=main.json --fail-on-warning`
3. Review the example files for Rust and TypeScript projects
