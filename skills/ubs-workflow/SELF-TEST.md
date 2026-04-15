# UBS Workflow Skill Self-Test

This checklist validates that the skill content meets quality requirements.

## Frontmatter Validation

- [x] `name` field matches directory name (`ubs-workflow`)
- [x] `description` is >= 10 characters
- [x] `triggers` array includes expected terms
- [x] `version` follows semver format
- [x] `author` is set to `jeffrey`

## Core Workflow Content

The skill MUST document these workflow steps:

### Step 1: Initial Scan

- [x] Documents `ubs --staged` command
- [x] Documents `ubs --diff` command
- [x] Documents full project scan (`ubs .`)
- [x] Shows language-specific flags (`--only=`)
- [x] Shows JSON output option

### Step 2: Prioritization

- [x] Defines severity levels (Critical/High/Medium/Low)
- [x] Maps UBS categories to severity
- [x] Includes decision tree for real bug vs false positive

### Step 3: Fix Plan

- [x] Requires root cause analysis
- [x] Requires code fix snippet
- [x] **Requires test case per fix** (critical)
- [x] Requires effort estimate

### Step 4: Apply Fixes

- [x] Documents test-first approach
- [x] Documents re-scan after fix
- [x] Documents commit message format

### Step 5: Suppression

- [x] Shows correct suppression syntax
- [x] **Requires justification comment** (critical)
- [x] Shows per-language comment styles

## Quick Reference Section

- [x] Core commands listed
- [x] Noise reduction flags documented
- [x] Output format options shown
- [x] Troubleshooting table present

## bv Integration (Optional)

- [x] Documents `ubs scan --format bv | bv import` pattern
- [x] Explains integration benefit

## Package Contents Validation

Required files:

- [x] `SKILL.md` exists
- [x] `SELF-TEST.md` exists (this file)

Required directories:

- [x] `examples/` exists
- [x] `templates/` exists

Example files:

- [x] `examples/rust-review.md` exists
- [x] `examples/typescript-review.md` exists

Template files:

- [x] `templates/fix-template.md` exists

## Quality Checks

- [x] No walls of text - uses structured headings and tables
- [x] Commands are copy-paste ready (code fences)
- [x] Next action is always clear
- [x] Workflow is deterministic (same inputs -> same steps)

## Content Restrictions

- [x] Does NOT contain skill-creation methodology
- [x] Does NOT contain protected content patterns
- [x] Is a normal skill package, not meta-content

## Test Commands

Run these to validate the skill works as documented:

```bash
# Verify UBS is available
ubs --version

# Test the staged workflow
echo "test" > /tmp/test.ts
ubs /tmp/test.ts

# Verify JSON output works
ubs /tmp/test.ts --format=jsonl
```

---

## Validation Result

If all checkboxes above are checked, the skill meets launch quality.

**Status:** PASS
