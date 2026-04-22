/**
 * Tests for draftPostmortem (I6 — post-mortem draft engine).
 *
 * Invariants under test (from docs/plans/2026-04-21-v3-4-0-synthesized.md
 * §4.Subsystem3):
 *   P-1 empty session         → warnings=['postmortem_empty_session'], no throw
 *   P-2 stale checkpoint      → warnings=['postmortem_checkpoint_stale'], uses fallback
 *   P-3 no auto-commit        → NEVER writes to CASS (spy cm/store: 0 calls)
 *   P-4 dual fallback         → sessionStartSha + merge-base both fail → HEAD~10..HEAD
 *   Happy-path                → commits + inbox → draft markdown contains everything
 *   Top error codes           → 7 codes → top-5 rendered, sorted by count
 *   G-1 Zod round-trip        → every return passes PostmortemDraftSchema.parse()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { draftPostmortem, formatPostmortemMarkdown, } from '../episodic-memory.js';
import { PostmortemDraftSchema } from '../types.js';
// ─── Mock agent-mail at the module boundary ─────────────────
// We mock agentMailRPC so we can stub fetch_inbox responses and capture
// the tool name used. The real implementation shells out via `curl`.
const fetchInboxResponses = {};
vi.mock('../agent-mail.js', () => ({
    agentMailRPC: vi.fn(async (_exec, toolName) => {
        if (toolName === 'fetch_inbox') {
            return { ok: true, data: fetchInboxResponses.default ?? { messages: [] } };
        }
        return { ok: true, data: null };
    }),
    unwrapRPC: (r) => (r?.ok ? r.data : null),
}));
function makeExec(scripts) {
    const calls = [];
    const exec = vi.fn(async (cmd, args) => {
        calls.push({ cmd, args });
        for (const s of scripts) {
            if (s.match(cmd, args))
                return s.result;
        }
        // Unmatched — default non-zero exit, mirrors createMockExec.
        return { code: 1, stdout: '', stderr: 'not mocked' };
    });
    return { exec: exec, calls };
}
function gitCatFileSucceeds(sha) {
    return {
        match: (cmd, args) => cmd === 'git' && args[0] === 'cat-file' && args[1] === '-e' && args[2] === sha,
        result: { code: 0, stdout: '', stderr: '' },
    };
}
function gitCatFileFails(sha) {
    return {
        match: (cmd, args) => cmd === 'git' && args[0] === 'cat-file' && args[1] === '-e' && args[2] === sha,
        result: { code: 1, stdout: '', stderr: `fatal: Not a valid object name ${sha}` },
    };
}
function gitMergeBase(result) {
    return {
        match: (cmd, args) => cmd === 'git' && args[0] === 'merge-base',
        result: result.ok
            ? { code: 0, stdout: `${result.sha}\n`, stderr: '' }
            : { code: 128, stdout: '', stderr: 'fatal: not a merge base' },
    };
}
function gitLogCommits(range, subjects) {
    return {
        match: (cmd, args) => {
            if (cmd !== 'git' || args[0] !== 'log')
                return false;
            if (args[args.length - 1] !== '--no-merges')
                return false;
            if (range && args[1] !== range)
                return false;
            return args.some((a) => a.startsWith('--pretty=format:%h|%s|%an'));
        },
        result: {
            code: 0,
            stdout: subjects
                .map((s) => `${s.sha}|${s.subject}|${s.author ?? 'test-author'}`)
                .join('\n'),
            stderr: '',
        },
    };
}
function gitLogStat(files) {
    return {
        match: (cmd, args) => cmd === 'git' && args[0] === 'log' && args.includes('--stat'),
        result: {
            code: 0,
            stdout: files.map((f) => ` ${f.path} | ${f.changes} +++--`).join('\n'),
            stderr: '',
        },
    };
}
function gitLogEmpty() {
    return {
        match: (cmd, args) => cmd === 'git' && args[0] === 'log' && args.some((a) => a.startsWith('--pretty=format:%h|%s|%an')),
        result: { code: 0, stdout: '', stderr: '' },
    };
}
// ─── Default context ────────────────────────────────────────
function makeCtx(partial) {
    return {
        cwd: '/fake/cwd',
        goal: 'Ship I6 post-mortem draft engine',
        phase: 'complete',
        ...partial,
    };
}
beforeEach(() => {
    // Reset mocked inbox responses to default
    fetchInboxResponses.default = { messages: [] };
});
// ─── Tests ──────────────────────────────────────────────────
describe('draftPostmortem', () => {
    // ─── P-1 empty session ────────────────────────────────────
    it('P-1: empty git log range → warnings include postmortem_empty_session, does not throw', async () => {
        const { exec } = makeExec([
            gitCatFileSucceeds('abc123'),
            gitLogEmpty(),
            // git stat won't be called because commits.length === 0
        ]);
        const ctx = makeCtx({ exec, sessionStartSha: 'abc123' });
        const draft = await draftPostmortem(ctx);
        expect(draft.warnings).toContain('postmortem_empty_session');
        expect(draft.hasWarnings).toBe(true);
        expect(draft.markdown).toContain('(no commits in range)');
        // Zod round-trip
        expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
    });
    // ─── P-2 stale checkpoint ─────────────────────────────────
    it('P-2: sessionStartSha missing from git log → warnings include postmortem_checkpoint_stale, falls back', async () => {
        const { exec, calls } = makeExec([
            gitCatFileFails('deadbeef'),
            gitMergeBase({ ok: true, sha: 'aaaaaaa' }),
            gitLogCommits('aaaaaaa..HEAD', [
                { sha: 'c1', subject: 'fix: edge case' },
            ]),
            gitLogStat([{ path: 'src/foo.ts', changes: 4 }]),
        ]);
        const ctx = makeCtx({ exec, sessionStartSha: 'deadbeef' });
        const draft = await draftPostmortem(ctx);
        expect(draft.warnings).toContain('postmortem_checkpoint_stale');
        expect(draft.hasWarnings).toBe(true);
        // Used merge-base fallback range
        const usedFallback = calls.some((c) => c.cmd === 'git' && c.args.includes('aaaaaaa..HEAD'));
        expect(usedFallback).toBe(true);
        expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
    });
    // ─── P-3 never auto-commits to CASS ───────────────────────
    it('P-3: draftPostmortem never invokes cm / flywheel_memory store — zero write calls', async () => {
        const { exec, calls } = makeExec([
            gitCatFileSucceeds('abc123'),
            gitLogCommits('abc123..HEAD', [{ sha: 'c1', subject: 'feat: x' }]),
            gitLogStat([{ path: 'src/x.ts', changes: 1 }]),
        ]);
        const ctx = makeCtx({ exec, sessionStartSha: 'abc123' });
        await draftPostmortem(ctx);
        // No cm CLI calls whatsoever
        const cmCalls = calls.filter((c) => c.cmd === 'cm');
        expect(cmCalls).toHaveLength(0);
        // No agentMailRPC call for anything that would mutate CASS
        const storeCalls = calls.filter((c) => c.cmd === 'cm' && (c.args[0] === 'add' || c.args[0] === 'store'));
        expect(storeCalls).toHaveLength(0);
    });
    // ─── P-4 dual fallback to HEAD~10 ─────────────────────────
    it('P-4: sessionStartSha AND merge-base both fail → falls back to HEAD~10..HEAD, warnings present', async () => {
        const { exec, calls } = makeExec([
            gitCatFileFails('deadbeef'),
            gitMergeBase({ ok: false }),
            gitLogCommits('HEAD~10..HEAD', [{ sha: 'c1', subject: 'chore: misc' }]),
            gitLogStat([{ path: 'README.md', changes: 2 }]),
        ]);
        const ctx = makeCtx({ exec, sessionStartSha: 'deadbeef' });
        const draft = await draftPostmortem(ctx);
        expect(draft.warnings).toContain('postmortem_checkpoint_stale');
        expect(draft.hasWarnings).toBe(true);
        const usedHeadFallback = calls.some((c) => c.cmd === 'git' && c.args[0] === 'log' && c.args.includes('HEAD~10..HEAD'));
        expect(usedHeadFallback).toBe(true);
        expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
    });
    // ─── Happy path ───────────────────────────────────────────
    it('happy path: 5 commits + 3 completion messages → draft includes every subject', async () => {
        fetchInboxResponses.default = {
            messages: [
                { subject: '[impl] bead-001 done', sender_name: 'LilacRidge', importance: 'normal' },
                { subject: '[impl] bead-002 done', sender_name: 'MossCreek', importance: 'normal' },
                { subject: '[impl] bead-003 done', sender_name: 'LavenderGate', importance: 'normal' },
                // Non-impl — should not be picked up as completion
                { subject: 'ping', sender_name: 'LilacRidge', importance: 'low' },
            ],
        };
        const subjects = [
            { sha: 'c1', subject: 'feat: one' },
            { sha: 'c2', subject: 'feat: two' },
            { sha: 'c3', subject: 'fix: three' },
            { sha: 'c4', subject: 'refactor: four' },
            { sha: 'c5', subject: 'docs: five' },
        ];
        const { exec } = makeExec([
            gitCatFileSucceeds('abc123'),
            gitLogCommits('abc123..HEAD', subjects),
            gitLogStat([
                { path: 'src/a.ts', changes: 20 },
                { path: 'src/b.ts', changes: 10 },
                { path: 'src/c.ts', changes: 5 },
            ]),
        ]);
        const ctx = makeCtx({ exec, sessionStartSha: 'abc123' });
        const draft = await draftPostmortem(ctx);
        expect(draft.hasWarnings).toBe(false);
        expect(draft.warnings).toEqual([]);
        // Every commit subject present
        for (const s of subjects) {
            expect(draft.markdown).toContain(s.subject);
        }
        // Every completion subject present
        expect(draft.markdown).toContain('[impl] bead-001 done');
        expect(draft.markdown).toContain('[impl] bead-002 done');
        expect(draft.markdown).toContain('[impl] bead-003 done');
        // Coordinator extraction picked first TitleCase sender
        expect(draft.markdown).toContain('LilacRidge');
        // Top 3 files rendered
        expect(draft.markdown).toContain('src/a.ts');
        expect(draft.markdown).toContain('src/b.ts');
        expect(draft.markdown).toContain('src/c.ts');
        expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
    });
    // ─── Top error codes ──────────────────────────────────────
    it('top error codes: telemetry with 7 codes → draft includes top-5 sorted by count', async () => {
        const telemetry = {
            version: 1,
            sessionStartIso: new Date().toISOString(),
            counts: {
                cli_failure: 10,
                invalid_input: 7,
                exec_timeout: 5,
                exec_aborted: 4,
                postmortem_empty_session: 3,
                postmortem_checkpoint_stale: 2,
                cli_not_available: 1,
            },
            recentEvents: [],
        };
        const { exec } = makeExec([
            gitCatFileSucceeds('abc123'),
            gitLogCommits('abc123..HEAD', [{ sha: 'c1', subject: 'feat: x' }]),
            gitLogStat([{ path: 'x.ts', changes: 1 }]),
        ]);
        const ctx = makeCtx({ exec, sessionStartSha: 'abc123', errorCodeTelemetry: telemetry });
        const draft = await draftPostmortem(ctx);
        // Top 5 codes (by count) — cli_failure, invalid_input, exec_timeout,
        // exec_aborted, postmortem_empty_session — all present.
        expect(draft.markdown).toContain('cli_failure: 10');
        expect(draft.markdown).toContain('invalid_input: 7');
        expect(draft.markdown).toContain('exec_timeout: 5');
        expect(draft.markdown).toContain('exec_aborted: 4');
        expect(draft.markdown).toContain('postmortem_empty_session: 3');
        // Lower-ranked codes excluded
        expect(draft.markdown).not.toContain('cli_not_available: 1');
        // `postmortem_checkpoint_stale: 2` is the 6th by count — must be out
        expect(draft.markdown).not.toContain('postmortem_checkpoint_stale: 2');
        expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
    });
    // ─── Zod round-trip across all branches ───────────────────
    it('Zod round-trip: valid PostmortemDraft on empty, stale, happy, and fallback branches', async () => {
        const scenarios = [
            // empty
            async () => {
                const { exec } = makeExec([
                    gitCatFileSucceeds('abc'),
                    gitLogEmpty(),
                ]);
                const d = await draftPostmortem(makeCtx({ exec, sessionStartSha: 'abc' }));
                expect(PostmortemDraftSchema.parse(d)).toEqual(d);
            },
            // stale
            async () => {
                const { exec } = makeExec([
                    gitCatFileFails('abc'),
                    gitMergeBase({ ok: true, sha: 'def' }),
                    gitLogCommits('def..HEAD', [{ sha: 'c1', subject: 'x' }]),
                    gitLogStat([{ path: 'y.ts', changes: 1 }]),
                ]);
                const d = await draftPostmortem(makeCtx({ exec, sessionStartSha: 'abc' }));
                expect(PostmortemDraftSchema.parse(d)).toEqual(d);
            },
            // fallback HEAD~10
            async () => {
                const { exec } = makeExec([
                    gitCatFileFails('abc'),
                    gitMergeBase({ ok: false }),
                    gitLogCommits('HEAD~10..HEAD', [{ sha: 'c1', subject: 'z' }]),
                    gitLogStat([{ path: 'z.ts', changes: 1 }]),
                ]);
                const d = await draftPostmortem(makeCtx({ exec, sessionStartSha: 'abc' }));
                expect(PostmortemDraftSchema.parse(d)).toEqual(d);
            },
        ];
        for (const s of scenarios)
            await s();
    });
});
// ─── formatPostmortemMarkdown ───────────────────────────────
describe('formatPostmortemMarkdown', () => {
    it('returns raw markdown when no warnings', async () => {
        const { exec } = makeExec([
            gitCatFileSucceeds('abc'),
            gitLogCommits('abc..HEAD', [{ sha: 'c1', subject: 'feat: happy' }]),
            gitLogStat([{ path: 'a.ts', changes: 1 }]),
        ]);
        const draft = await draftPostmortem(makeCtx({ exec, sessionStartSha: 'abc' }));
        const rendered = formatPostmortemMarkdown(draft);
        expect(rendered).toBe(draft.markdown);
        expect(rendered).not.toContain('**Warnings:**');
    });
    it('prepends a warning banner when hasWarnings=true', async () => {
        const { exec } = makeExec([
            gitCatFileSucceeds('abc'),
            gitLogEmpty(),
        ]);
        const draft = await draftPostmortem(makeCtx({ exec, sessionStartSha: 'abc' }));
        const rendered = formatPostmortemMarkdown(draft);
        expect(rendered).toContain('**Warnings:**');
        expect(rendered).toContain('postmortem_empty_session');
        // Markdown body still follows
        expect(rendered).toContain('Session (');
    });
});
//# sourceMappingURL=episodic-memory.postmortem.test.js.map