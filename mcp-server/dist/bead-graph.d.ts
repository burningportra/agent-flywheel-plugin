export interface BeadNode {
    id: string;
    title: string;
    status: "open" | "in_progress" | "closed" | "deferred";
    priority?: number;
    labels?: string[];
}
export interface BeadEdge {
    from: string;
    to: string;
    type: "blocks" | "parent-child" | "related";
}
export interface BeadCycle {
    beadIds: string[];
}
export interface BeadGraph {
    nodes: BeadNode[];
    edges: BeadEdge[];
    cycles: BeadCycle[];
    generatedAt: string;
}
export declare function buildBeadGraph(listJson: unknown[], depJson: unknown[]): BeadGraph;
//# sourceMappingURL=bead-graph.d.ts.map