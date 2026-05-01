import { agentMailRPC } from "./agent-mail.js";
import { createLogger } from "./logger.js";
const log = createLogger("agent-mail-helpers");
// Default TTL for reservation grants (1 hour).
const DEFAULT_TTL_SECONDS = 3600;
// Default backoff between the two reservation attempts.
const DEFAULT_RETRY_DELAY_MS = 250;
function extractIds(granted) {
    const ids = [];
    for (const reservation of granted) {
        const id = reservation.id;
        if (typeof id === "number" || typeof id === "string") {
            ids.push(id);
        }
    }
    return ids;
}
async function attemptReserve(paths, opts) {
    const result = await agentMailRPC(opts.exec, "file_reservation_paths", {
        project_key: opts.cwd,
        agent_name: opts.agentName,
        paths,
        ttl_seconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS,
        exclusive: opts.exclusive ?? true,
        ...(opts.reason ? { reason: opts.reason } : {}),
    });
    if (!result.ok) {
        return {
            kind: "rpc_error",
            granted: [],
            conflicts: [],
            rpcError: { kind: result.error.kind, message: result.error.message },
        };
    }
    const granted = Array.isArray(result.data?.granted) ? result.data.granted : [];
    const conflicts = Array.isArray(result.data?.conflicts) ? result.data.conflicts : [];
    if (conflicts.length > 0) {
        // Mixed-mode response: server may populate BOTH granted and conflicts.
        // The known agent-mail bug (advisory enforcement) means we must treat
        // any non-empty conflicts as failure even if granted is also populated.
        // Caller-side mitigation per AGENTS.md "Known issue".
        return { kind: "conflict", granted, conflicts };
    }
    if (granted.length === 0) {
        return { kind: "empty", granted, conflicts };
    }
    return { kind: "ok", granted, conflicts };
}
function sleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
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
export async function reserveOrFail(paths, opts) {
    if (!Array.isArray(paths) || paths.length === 0) {
        return {
            ok: false,
            reason: "invalid_args",
            conflicts: [],
            attempts: 0,
            error: { kind: "invalid_args", message: "paths must be a non-empty array" },
        };
    }
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxAttempts = 2;
    let attempts = 0;
    let last = null;
    for (let i = 0; i < maxAttempts; i++) {
        attempts++;
        last = await attemptReserve(paths, opts);
        if (last.kind === "ok") {
            return {
                ok: true,
                reservationIds: extractIds(last.granted),
                granted: last.granted,
                attempts,
            };
        }
        if (last.kind === "rpc_error") {
            return {
                ok: false,
                reason: "rpc_error",
                conflicts: [],
                attempts,
                error: last.rpcError,
            };
        }
        if (last.kind === "empty") {
            return {
                ok: false,
                reason: "empty_response",
                conflicts: [],
                attempts,
                error: {
                    kind: "empty_response",
                    message: "agent-mail returned an empty granted array with no conflicts",
                },
            };
        }
        // last.kind === "conflict" — release any spurious mixed-mode grants
        // so the caller never holds a zombie reservation it believes to be failed.
        const spuriousIds = extractIds(last.granted);
        if (spuriousIds.length > 0) {
            log.warn("releasing spurious grants from conflicted response", {
                ids: spuriousIds,
                conflictCount: last.conflicts.length,
            });
            const releaseResult = await releaseReservations(spuriousIds, {
                exec: opts.exec,
                cwd: opts.cwd,
                agentName: opts.agentName,
            });
            if (!releaseResult.ok) {
                log.warn("failed to release spurious grants", {
                    ids: spuriousIds,
                    error: releaseResult.error,
                });
            }
        }
        if (i < maxAttempts - 1) {
            await sleep(retryDelayMs);
        }
    }
    return {
        ok: false,
        reason: "conflicts",
        conflicts: last?.conflicts ?? [],
        attempts,
    };
}
/**
 * Release reservations by id. Symmetric counterpart to `reserveOrFail`.
 *
 * No-op (returns ok with released:0) for an empty id list. Coerces
 * numeric-string ids to numbers because the agent-mail RPC schema for
 * `release_file_reservations` declares `file_reservation_ids: list[int]`.
 */
export async function releaseReservations(reservationIds, opts) {
    if (!reservationIds || reservationIds.length === 0) {
        return { ok: true, released: 0 };
    }
    const ids = [];
    for (const raw of reservationIds) {
        if (typeof raw === "number" && Number.isFinite(raw)) {
            ids.push(raw);
        }
        else if (typeof raw === "string" && /^\d+$/.test(raw)) {
            ids.push(Number(raw));
        }
        else if (typeof raw === "string" && raw.length > 0) {
            ids.push(raw);
        }
    }
    if (ids.length === 0) {
        return { ok: true, released: 0 };
    }
    const result = await agentMailRPC(opts.exec, "release_file_reservations", {
        project_key: opts.cwd,
        agent_name: opts.agentName,
        file_reservation_ids: ids,
    });
    if (!result.ok) {
        return {
            ok: false,
            error: { kind: result.error.kind, message: result.error.message },
        };
    }
    const releasedRaw = result.data?.released;
    const released = typeof releasedRaw === "number" ? releasedRaw : ids.length;
    return { ok: true, released };
}
//# sourceMappingURL=agent-mail-helpers.js.map