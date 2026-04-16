import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { makeExec } from './exec.js';
import { clearState, loadState, saveState } from './state.js';
import type { McpToolResult, FlywheelToolName, ToolContext } from './types.js';
type ToolRunner = (ctx: ToolContext, args: any) => Promise<McpToolResult>;
type ToolRunnerMap = Partial<Record<FlywheelToolName, ToolRunner>>;
interface ToolValidationError {
    message: string;
    field?: string;
    reason: 'missing_required_parameter' | 'invalid_cwd';
}
interface CallToolHandlerDependencies {
    makeExec: typeof makeExec;
    loadState: typeof loadState;
    saveState: typeof saveState;
    clearState: typeof clearState;
    runners?: ToolRunnerMap;
}
export declare const TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            goal: {
                type: string;
                description: string;
            };
            force: {
                type: string;
                description: string;
            };
            ideas?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            action?: undefined;
            advancedAction?: undefined;
            beadId?: undefined;
            beadIds?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            ideas: {
                type: string;
                description: string;
                minItems: number;
                maxItems: number;
                items: {
                    type: string;
                    properties: {
                        id: {
                            type: string;
                            description: string;
                        };
                        title: {
                            type: string;
                            description: string;
                        };
                        description: {
                            type: string;
                            description: string;
                        };
                        category: {
                            type: string;
                            enum: string[];
                        };
                        effort: {
                            type: string;
                            enum: string[];
                        };
                        impact: {
                            type: string;
                            enum: string[];
                        };
                        rationale: {
                            type: string;
                            description: string;
                        };
                        tier: {
                            type: string;
                            enum: string[];
                        };
                        sourceEvidence: {
                            type: string;
                            items: {
                                type: string;
                            };
                        };
                        scores: {
                            type: string;
                            properties: {
                                useful: {
                                    type: string;
                                };
                                pragmatic: {
                                    type: string;
                                };
                                accretive: {
                                    type: string;
                                };
                                robust: {
                                    type: string;
                                };
                                ergonomic: {
                                    type: string;
                                };
                            };
                        };
                        risks: {
                            type: string;
                            items: {
                                type: string;
                            };
                        };
                        synergies: {
                            type: string;
                            items: {
                                type: string;
                            };
                        };
                    };
                    required: string[];
                };
            };
            goal?: undefined;
            force?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            action?: undefined;
            advancedAction?: undefined;
            beadId?: undefined;
            beadIds?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            goal: {
                type: string;
                description: string;
            };
            force?: undefined;
            ideas?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            action?: undefined;
            advancedAction?: undefined;
            beadId?: undefined;
            beadIds?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            mode: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            planFile: {
                type: string;
                description: string;
            };
            planContent: {
                type: string;
                description: string;
            };
            goal?: undefined;
            force?: undefined;
            ideas?: undefined;
            action?: undefined;
            advancedAction?: undefined;
            beadId?: undefined;
            beadIds?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            action: {
                type: string;
                enum: string[];
                description: string;
            };
            advancedAction: {
                type: string;
                enum: string[];
                description: string;
            };
            goal?: undefined;
            force?: undefined;
            ideas?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            beadId?: undefined;
            beadIds?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            beadId: {
                type: string;
                description: string;
            };
            action: {
                type: string;
                enum: string[];
                description: string;
            };
            goal?: undefined;
            force?: undefined;
            ideas?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            advancedAction?: undefined;
            beadIds?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            beadIds: {
                type: string;
                description: string;
                minItems: number;
                items: {
                    type: string;
                };
            };
            goal?: undefined;
            force?: undefined;
            ideas?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            action?: undefined;
            advancedAction?: undefined;
            beadId?: undefined;
            query?: undefined;
            operation?: undefined;
            content?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            query: {
                type: string;
                description: string;
            };
            operation: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
            goal?: undefined;
            force?: undefined;
            ideas?: undefined;
            mode?: undefined;
            planFile?: undefined;
            planContent?: undefined;
            action?: undefined;
            advancedAction?: undefined;
            beadId?: undefined;
            beadIds?: undefined;
        };
        required: string[];
    };
})[];
export declare function validateToolArgs(toolName: string, args: Record<string, unknown>): ToolValidationError | null;
export declare function createCallToolHandler(dependencies: CallToolHandlerDependencies): (request: {
    params: {
        name: string;
        arguments?: Record<string, unknown>;
    };
}) => Promise<McpToolResult>;
export declare function createServer(): Server;
export declare const server: Server<{
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    [x: string]: unknown;
    _meta?: {
        [x: string]: unknown;
        progressToken?: string | number | undefined;
        "io.modelcontextprotocol/related-task"?: {
            taskId: string;
        } | undefined;
    } | undefined;
}>;
export {};
//# sourceMappingURL=server.d.ts.map