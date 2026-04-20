import { type FlywheelState } from './types.js';
export declare function loadState(cwd: string): FlywheelState;
export declare function saveState(cwd: string, state: FlywheelState): Promise<boolean>;
export declare function clearState(cwd: string): void;
//# sourceMappingURL=state.d.ts.map