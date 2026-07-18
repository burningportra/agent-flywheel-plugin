# opencode/fixtures/homes

Fake-home fixtures + reusable helpers for the black-box sync test suite
(`install/test/test-sync-opencode.bats`, bead claude-19xh / T7).

**Discipline: no test ever touches the runner's real `~/.config/opencode`.**
Every case runs the sync against a throwaway `mktemp -d` config dir via
`--config-dir` (or `--config-file` / `OPENCODE_CONFIG_DIR`), and the bats
`setup()` re-points `HOME` and `XDG_CONFIG_HOME` at a fake home so even an
accidental fallback resolves inside the sandbox. `opencode` itself is stubbed
onto `PATH` so no case spawns the real binary or its config.

Files:

- `opencode.jsonc` — a user config with a comment, trailing commas, and an
  unrelated `mcp.some-other-server` entry. The custom-config case merges
  `mcp.flywheel` into it and asserts the comment and the foreign server survive
  (the JSONC-preserving merge, T4, proven black-box).

Sandbox mini-repos (for the source-mutation cases: source upgrade, retirement,
spaces/non-ASCII repo path, unclassified-token) are materialized at runtime by
the bats `sandbox_repo` helper, which copies the live engine
(`scripts/opencode/*.mjs`), the owned `opencode/` assets, `hooks/hooks.json`,
and the real `skills/`+`commands/` sources into a temp dir. Copying the live
tree (rather than committing a hand-authored fixture repo) keeps the sandbox
in lockstep with the real manifest, compatibility policy, and transforms.
