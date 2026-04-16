/**
 * Domain-Specific Prompt Enhancement
 *
 * Sharpens review prompts with stack-specific checklist items based on the
 * profiler's detected tech stack (e.g., stale closures for React, unwrap()
 * in non-test Rust code).
 */
// ─── Checklists ─────────────────────────────────────────────
const DOMAIN_CHECKLISTS = [
    // ── TypeScript + React ──────────────────────────────────
    {
        language: "TypeScript",
        framework: "React",
        blunderHuntItems: [
            "Stale closure captures in useEffect/useCallback/useMemo",
            "Missing or incorrect dependency arrays in hooks",
            "Key prop issues in list rendering (using array index as key)",
            "Memory leaks from unsubscribed event listeners, intervals, or AbortControllers",
            "Race conditions in async state updates (setState after unmount)",
            "Unnecessary re-renders from unstable object/array references in props",
            "Conditional hook calls violating the Rules of Hooks",
        ],
        reviewItems: [
            "Are all hooks following the Rules of Hooks (not conditional, not in loops)?",
            "Are expensive computations memoized with useMemo where appropriate?",
            "Do effects clean up subscriptions, timers, and abort controllers?",
        ],
        antiPatterns: [
            "Using `any` type to suppress errors instead of fixing type mismatches",
            "Prop drilling through 4+ levels when context or composition would be cleaner",
            "Direct DOM manipulation instead of using refs",
        ],
    },
    // ── TypeScript + Next.js ────────────────────────────────
    {
        language: "TypeScript",
        framework: "Next.js",
        blunderHuntItems: [
            "Stale closure captures in useEffect/useCallback/useMemo",
            "Server/client component boundary violations ('use client' missing or misplaced)",
            "Importing server-only modules in client components",
            "Missing or incorrect dependency arrays in hooks",
            "Memory leaks from unsubscribed event listeners or intervals",
            "Incorrect use of `cookies()` or `headers()` outside of server components/actions",
            "Missing `revalidatePath`/`revalidateTag` after data mutations",
        ],
        reviewItems: [
            "Are server and client component boundaries correct?",
            "Are data fetching patterns using server components where possible?",
            "Do server actions validate input before mutating data?",
        ],
        antiPatterns: [
            "Fetching data in client components when server components would eliminate waterfalls",
            "'use client' at the top of every file instead of pushing it to leaf components",
        ],
    },
    // ── TypeScript (generic) ────────────────────────────────
    {
        language: "TypeScript",
        blunderHuntItems: [
            "Promise.all without error boundaries (one rejection kills all)",
            "Uncaught async errors in event handlers or callbacks",
            "Type assertions (`as`) hiding real type mismatches",
            "Missing null/undefined checks on optional chaining results used as arguments",
            "Import paths that assume specific module resolution (missing .js extensions for ESM)",
            "Implicit `any` from untyped third-party libraries",
        ],
        reviewItems: [
            "Are error paths handling all possible rejection/throw scenarios?",
            "Do type assertions have a comment explaining why they're safe?",
        ],
        antiPatterns: [
            "Using `as any` to silence the compiler instead of fixing the type",
            "Barrel files (index.ts re-exports) that defeat tree-shaking",
        ],
    },
    // ── Rust ────────────────────────────────────────────────
    {
        language: "Rust",
        blunderHuntItems: [
            "Unwrap()/expect() on Results/Options in non-test, non-CLI code",
            "Missing error propagation with the `?` operator",
            "Unnecessary `.clone()` where references or borrows would work",
            "Unsafe blocks without `// SAFETY:` comments explaining the invariant",
            "Deadlock potential from inconsistent Mutex/RwLock acquisition ordering",
            "Panicking in library code (should return Result instead)",
            "Missing Send/Sync bounds on types used across threads",
        ],
        reviewItems: [
            "Are all `unsafe` blocks justified with a SAFETY comment?",
            "Does every public function that can fail return Result?",
            "Are lifetimes explicitly annotated where the compiler can't infer them?",
        ],
        antiPatterns: [
            "Using `String` everywhere instead of `&str` for read-only access",
            "Box<dyn Error> instead of a proper error enum for library APIs",
        ],
    },
    // ── Python ──────────────────────────────────────────────
    {
        language: "Python",
        blunderHuntItems: [
            "Mutable default arguments in function signatures (def f(x=[]))",
            "Missing exception handling on I/O, network, and subprocess operations",
            "Global state mutations in module-level code that runs on import",
            "f-string or .format() injection vulnerabilities with user input",
            "Missing `with` statements for file handles and connections",
            "Bare `except:` clauses that swallow all exceptions including KeyboardInterrupt",
        ],
        reviewItems: [
            "Are all external calls wrapped in appropriate exception handling?",
            "Do function signatures have type hints?",
            "Are context managers used for resource management?",
        ],
        antiPatterns: [
            "Catching Exception instead of specific exception types",
            "Using `import *` which pollutes namespace",
        ],
    },
    // ── Go ──────────────────────────────────────────────────
    {
        language: "Go",
        blunderHuntItems: [
            "Ignored error returns (_, err := f(); without checking err)",
            "Goroutine leaks from unbuffered channels or missing context cancellation",
            "Data races from shared state without mutex or channel protection",
            "Deferred function calls in loops (resource accumulation until function returns)",
            "Nil pointer dereference on interface values that appear non-nil",
            "Missing `defer resp.Body.Close()` after HTTP calls",
        ],
        reviewItems: [
            "Is every error return checked and handled?",
            "Do all goroutines have a clean shutdown path via context.Context?",
            "Are concurrent data accesses protected by sync primitives?",
        ],
        antiPatterns: [
            "Using `panic()` for recoverable errors instead of returning error",
            "Exported global variables that create hidden coupling",
        ],
    },
];
// ─── Lookup ─────────────────────────────────────────────────
/**
 * Find the best-matching domain checklist for a repo profile.
 * Prefers language+framework match, falls back to language-only.
 * Returns null if no checklist matches the project's stack.
 */
export function getDomainChecklist(profile) {
    const langs = profile.languages.map(l => l.toLowerCase());
    const frameworks = profile.frameworks.map(f => f.toLowerCase());
    // First pass: match language + framework
    for (const checklist of DOMAIN_CHECKLISTS) {
        if (checklist.framework &&
            langs.includes(checklist.language.toLowerCase()) &&
            frameworks.includes(checklist.framework.toLowerCase())) {
            return checklist;
        }
    }
    // Second pass: match language only (no framework)
    for (const checklist of DOMAIN_CHECKLISTS) {
        if (!checklist.framework && langs.includes(checklist.language.toLowerCase())) {
            return checklist;
        }
    }
    return null;
}
/**
 * Format a domain checklist's blunder hunt items as a numbered list
 * suitable for appending to a blunder hunt prompt.
 */
export function formatDomainBlunderItems(checklist) {
    if (checklist.blunderHuntItems.length === 0)
        return "";
    const header = checklist.framework
        ? `### ${checklist.language}/${checklist.framework}-Specific Checks`
        : `### ${checklist.language}-Specific Checks`;
    const items = checklist.blunderHuntItems
        .map((item, i) => `${i + 1}. ${item}`)
        .join("\n");
    return `\n\n${header}\n${items}`;
}
/**
 * Format a domain checklist's review items as a numbered list
 * suitable for appending to review prompts.
 */
export function formatDomainReviewItems(checklist) {
    if (checklist.reviewItems.length === 0)
        return "";
    const header = checklist.framework
        ? `### ${checklist.language}/${checklist.framework}-Specific Review`
        : `### ${checklist.language}-Specific Review`;
    const items = checklist.reviewItems
        .map((item, i) => `${i + 1}. ${item}`)
        .join("\n");
    const antiPatterns = checklist.antiPatterns.length > 0
        ? `\n\n### Known Anti-Patterns\n${checklist.antiPatterns.map(ap => `- ⚠️ ${ap}`).join("\n")}`
        : "";
    return `\n\n${header}\n${items}${antiPatterns}`;
}
//# sourceMappingURL=domain-knowledge.js.map