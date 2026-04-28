import { z } from "zod";
// ─── Input Schemas ───────────────────────────────────────────
const BeadListRowSchema = z
    .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["open", "in_progress", "closed", "deferred"]),
    priority: z.number().optional(),
    labels: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).optional(),
})
    .passthrough();
const DepRowSchema = z
    .object({
    from: z.string(),
    to: z.string(),
    type: z.enum(["blocks", "parent-child", "related"]).optional(),
})
    .passthrough();
function tarjanSCC(nodeIds, adjacency) {
    const state = new Map();
    const stack = [];
    const sccs = [];
    let counter = 0;
    for (const root of nodeIds) {
        if (state.has(root))
            continue;
        const callStack = [{ node: root, neighborIdx: 0, callerNode: null }];
        while (callStack.length > 0) {
            const frame = callStack[callStack.length - 1];
            const { node } = frame;
            if (!state.has(node)) {
                state.set(node, { index: counter, lowlink: counter, onStack: true });
                counter++;
                stack.push(node);
            }
            const neighbors = adjacency.get(node) ?? [];
            let advanced = false;
            while (frame.neighborIdx < neighbors.length) {
                const w = neighbors[frame.neighborIdx];
                frame.neighborIdx++;
                if (!state.has(w)) {
                    callStack.push({ node: w, neighborIdx: 0, callerNode: node });
                    advanced = true;
                    break;
                }
                else if (state.get(w).onStack) {
                    const ns = state.get(node);
                    const ws = state.get(w);
                    ns.lowlink = Math.min(ns.lowlink, ws.index);
                }
            }
            if (!advanced) {
                callStack.pop();
                // Propagate lowlink to caller
                if (frame.callerNode !== null) {
                    const callerState = state.get(frame.callerNode);
                    const nodeState = state.get(node);
                    callerState.lowlink = Math.min(callerState.lowlink, nodeState.lowlink);
                }
                const ns = state.get(node);
                if (ns.lowlink === ns.index) {
                    const scc = [];
                    let popped;
                    do {
                        popped = stack.pop();
                        state.get(popped).onStack = false;
                        scc.push(popped);
                    } while (popped !== node);
                    sccs.push(scc);
                }
            }
        }
    }
    return sccs;
}
// ─── Public API ──────────────────────────────────────────────
export function buildBeadGraph(listJson, depJson) {
    // Parse + validate inputs
    const nodes = [];
    for (const row of listJson) {
        const parsed = BeadListRowSchema.safeParse(row);
        if (!parsed.success)
            continue;
        const d = parsed.data;
        nodes.push({
            id: d.id,
            title: d.title,
            status: d.status,
            ...(d.priority !== undefined ? { priority: d.priority } : {}),
            ...(d.labels !== undefined ? { labels: d.labels } : {}),
        });
    }
    const nodeIds = nodes.map((n) => n.id);
    const nodeIdSet = new Set(nodeIds);
    const edges = [];
    // Edges from depJson (explicit dep rows)
    for (const row of depJson) {
        const parsed = DepRowSchema.safeParse(row);
        if (!parsed.success)
            continue;
        const d = parsed.data;
        if (!nodeIdSet.has(d.from) || !nodeIdSet.has(d.to))
            continue;
        edges.push({
            from: d.from,
            to: d.to,
            type: d.type ?? "blocks",
        });
    }
    // Also mine inline `dependencies` arrays from listJson rows
    for (const row of listJson) {
        const parsed = BeadListRowSchema.safeParse(row);
        if (!parsed.success)
            continue;
        const d = parsed.data;
        if (!d.dependencies)
            continue;
        for (const dep of d.dependencies) {
            if (!nodeIdSet.has(dep))
                continue;
            const exists = edges.some((e) => e.from === d.id && e.to === dep);
            if (!exists) {
                edges.push({ from: d.id, to: dep, type: "blocks" });
            }
        }
    }
    // Build adjacency list (from → [to, ...]) for SCC
    const adjacency = new Map();
    for (const id of nodeIds) {
        adjacency.set(id, []);
    }
    for (const edge of edges) {
        adjacency.get(edge.from)?.push(edge.to);
    }
    // Tarjan SCC
    const sccs = tarjanSCC(nodeIds, adjacency);
    // Keep only SCCs with size >= 2 or self-loops
    const selfLoopIds = new Set();
    for (const edge of edges) {
        if (edge.from === edge.to)
            selfLoopIds.add(edge.from);
    }
    const rawCycles = [];
    for (const scc of sccs) {
        if (scc.length >= 2) {
            rawCycles.push({ beadIds: [...scc].sort() });
        }
        else if (scc.length === 1 && selfLoopIds.has(scc[0])) {
            rawCycles.push({ beadIds: [scc[0]] });
        }
    }
    // Sort cycles: by smallest id within cycle, then by length
    const cycles = rawCycles.sort((a, b) => {
        const minA = a.beadIds[0]; // already sorted
        const minB = b.beadIds[0];
        if (minA < minB)
            return -1;
        if (minA > minB)
            return 1;
        return a.beadIds.length - b.beadIds.length;
    });
    return {
        nodes,
        edges,
        cycles,
        generatedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=bead-graph.js.map