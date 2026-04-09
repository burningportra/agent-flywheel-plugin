---
name: ui-ux-polish
description: Run a structured UI/UX polish pass on implemented code. Spawns a scrutiny agent to generate 15-30 improvement suggestions, presents them numbered for user selection, converts selected ones to beads, and triggers implementation. Use after initial implementation is complete.
---

A structured polish phase for UI/UX quality: scrutiny → selection → bead conversion → implementation.

## Phase 1 — Scrutiny

Spawn a scrutiny sub-agent with this exact task prompt:

> "Great, now I want you to super carefully scrutinize every aspect of the application workflow and implementation and look for things that just seem sub-optimal or even wrong/mistaken to you, things that could very obviously be improved from a user-friendliness and intuitiveness standpoint, places where our UI/UX could be improved and polished to be slicker, more visually appealing, and more premium feeling and just ultra high quality, like Stripe-level apps."

If the user wants a second round of deeper suggestions after reviewing Phase 1 results, use this follow-up:

> "I still think there are strong opportunities to enhance the UI/UX look and feel and to make everything work better and be more intuitive, user-friendly, visually appealing, polished, slick, and world class in terms of following UI/UX best practices like those used by Stripe, don't you agree? And I want you to carefully consider desktop UI/UX and mobile UI/UX separately while doing this and hyper-optimize for both separately to play to the specifics of each modality. I'm looking for true world-class visual appeal, polish, slickness, etc. that makes people gasp at how stunning and perfect it is in every way. Use ultrathink."

The scrutiny agent should produce exactly 15–30 numbered improvement suggestions. Format:
```
N. [Component/File] — specific change and why it improves UX
```

## Phase 2 — Selection

Present the numbered suggestions to the user. Ask which to implement:
- By number: "1, 3, 5-8"
- By category: "all accessibility items"
- Or: "all"

## Phase 3 — Bead conversion

For each selected suggestion, call `br create` with:
- A concise title from the suggestion
- The full suggestion as the description body
- Acceptance criteria matching the specific UX change
- `### Files:` listing the relevant file(s)

## Phase 4 — Implementation

After bead creation, call `orch_approve_beads` to review the new beads and launch implementation via swarm.

## Phase 5 — De-slopification

After implementation, run a de-slopify pass on any documentation or UI copy files that were modified to remove AI writing patterns and improve documentation tone.
