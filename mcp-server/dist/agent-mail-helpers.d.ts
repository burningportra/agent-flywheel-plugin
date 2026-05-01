import type { ExecFn } from "./exec.js";
import { type AgentMailReservation } from "./agent-mail.js";
export interface ReservationConflictHolder {
    agent_name?: string;
    reservation_id?: number | string;
    expires_ts?: string;
    [key: string]: unknown;
}
export interface ReservationConflict {
    path: string;
    holders?: ReservationConflictHolder[];
    [key: string]: unknown;
}
export interface ReserveOrFailOpts {
    exec: ExecFn;
    cwd: string;
    agentName: string;
    ttlSeconds?: number;
    exclusive?: boolean;
    reason?: string;
    /**
     * Backoff between the first attempt and the single retry. Tests inject 0
     * to keep deterministic. Defaults to 250ms.
     */
    retryDelayMs?: number;
}
export type ReserveFailureReason = "conflicts" | "rpc_error" | "empty_response" | "invalid_args";
export type ReserveOrFailResult = {
    ok: true;
    reservationIds: Array<number | string>;
    granted: AgentMailReservation[];
    attempts: number;
} | {
    ok: false;
    reason: ReserveFailureReason;
    conflicts: ReservationConflict[];
    attempts: number;
    error?: {
        kind: string;
        message: string;
    };
};
export interface ReleaseReservationsOpts {
    exec: ExecFn;
    cwd: string;
    agentName: string;
}
export type ReleaseReservationsResult = {
    ok: true;
    released: number;
} | {
    ok: false;
    error: {
        kind: string;
        message: string;
    };
};
/**
 * Lock-aware reservation helper.
 *
 * Wraps `agentMailRPC("file_reservation_paths", ...)` with the safety contract
 * documented in AGENTS.md "Known issue: agent-mail exclusive-reservation
 * enforcement is advisory":
 *
 *   - Treats any non-empty `conflicts` array as failure, even when `granted`
 *     is also populated. Spurious grants from a mixed response are released
 *     immediately so the caller does not hold a zombie reservation.
 *   - Performs a single retry with exponential backoff on conflict, in case
 *     the conflicting holder's TTL is about to expire.
 *   - Does NOT retry on RPC/network failures — those need a higher-level
 *     circuit breaker, not blind retries.
 */
export declare function reserveOrFail(paths: string[], opts: ReserveOrFailOpts): Promise<ReserveOrFailResult>;
/**
 * Release reservations by id. Symmetric counterpart to `reserveOrFail`.
 *
 * No-op (returns ok with released:0) for an empty id list. Coerces
 * numeric-string ids to numbers because the agent-mail RPC schema for
 * `release_file_reservations` declares `file_reservation_ids: list[int]`.
 */
export declare function releaseReservations(reservationIds: Array<number | string>, opts: ReleaseReservationsOpts): Promise<ReleaseReservationsResult>;
//# sourceMappingURL=agent-mail-helpers.d.ts.map