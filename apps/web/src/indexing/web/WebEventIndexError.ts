/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Stable failure categories shared by the Web index Worker and its callers. */
export type WebEventIndexErrorCode =
    | "schema_error"
    | "storage_error"
    | "version_incompatible"
    | "connection_blocked"
    | "worker_failure"
    | "network_failure"
    | "permission_denied"
    | "cursor_unavailable"
    | "cancelled"
    | "unknown";

/** Operations allowed in a local search error payload. */
export const WEB_EVENT_INDEX_OPERATIONS = [
    "supportsEventIndexing",
    "initEventIndex",
    "setMaxEventAgeDays",
    "addEventToIndex",
    "deleteEvent",
    "applyEventEdit",
    "isEventIndexEmpty",
    "isRoomIndexed",
    "commitLiveEvents",
    "searchEventIndex",
    "addHistoricEvents",
    "addCrawlerCheckpoint",
    "removeCrawlerCheckpoint",
    "loadFileEvents",
    "queryFileEvents",
    "loadCheckpoints",
    "getCompletedRoomToken",
    "markRoomHistoryComplete",
    "getCompatibilityWarnings",
    "closeEventIndex",
    "getStats",
    "getUserVersion",
    "setUserVersion",
    "deleteEventIndex",
    "backfill",
    "rpc",
    "worker",
] as const;

export type WebEventIndexOperation = (typeof WEB_EVENT_INDEX_OPERATIONS)[number];

const SYNTHETIC_OPERATIONS = ["backfill", "rpc", "worker"] as const;

/** Worker operation names derived from the envelope allowlist; the handler table checks them exhaustively. */
export type WebEventIndexWorkerOperation = Exclude<WebEventIndexOperation, (typeof SYNTHETIC_OPERATIONS)[number]>;
export const WEB_EVENT_INDEX_WORKER_OPERATIONS = WEB_EVENT_INDEX_OPERATIONS.filter(
    (operation): operation is WebEventIndexWorkerOperation =>
        !SYNTHETIC_OPERATIONS.includes(operation as (typeof SYNTHETIC_OPERATIONS)[number]),
);

/** Recovery guidance for a search-index failure. */
export type WebEventIndexRetryability = "retry" | "reinitialize" | "user_action" | "never";

/** The safe error payload sent from the Web Worker to the main thread. */
export interface WebEventIndexErrorPayload {
    code: WebEventIndexErrorCode;
    operation: WebEventIndexOperation;
    retryability: WebEventIndexRetryability;
}

const SAFE_MESSAGES: Record<WebEventIndexErrorCode, string> = {
    schema_error: "The local event index needs to be reinitialized.",
    storage_error: "The browser could not store local search data.",
    version_incompatible: "The local event index version is not compatible.",
    connection_blocked: "Close older Element tabs, then retry local search.",
    worker_failure: "The local search worker stopped unexpectedly.",
    network_failure: "The server could not provide more room history.",
    permission_denied: "Older room history is not accessible.",
    cursor_unavailable: "The room history cursor could not be continued.",
    cancelled: "The search was cancelled.",
    unknown: "The local event index operation failed.",
};

const ERROR_CODES = new Set<WebEventIndexErrorCode>([
    "schema_error",
    "storage_error",
    "version_incompatible",
    "connection_blocked",
    "worker_failure",
    "network_failure",
    "permission_denied",
    "cursor_unavailable",
    "cancelled",
    "unknown",
]);

const ERROR_OPERATIONS = new Set<WebEventIndexOperation>(WEB_EVENT_INDEX_OPERATIONS);

const RETRYABILITIES = new Set<WebEventIndexRetryability>(["retry", "reinitialize", "user_action", "never"]);

/** A non-sensitive, serializable failure from the local Web event index. */
export class WebEventIndexError extends Error {
    public readonly code: WebEventIndexErrorCode;
    public readonly operation: WebEventIndexOperation;
    public readonly retryability: WebEventIndexRetryability;

    public constructor(payload: WebEventIndexErrorPayload) {
        super(SAFE_MESSAGES[payload.code]);
        this.name = "WebEventIndexError";
        this.code = payload.code;
        this.operation = payload.operation;
        this.retryability = payload.retryability;
    }

    /** Convert a native failure without forwarding its potentially sensitive message. */
    public static from(error: unknown, operation: WebEventIndexOperation): WebEventIndexError {
        if (error instanceof WebEventIndexError) return error;

        const name =
            typeof DOMException !== "undefined" && error instanceof DOMException
                ? error.name
                : error instanceof Error
                  ? error.name
                  : "";
        switch (name) {
            case "NotFoundError":
                return new WebEventIndexError({ code: "schema_error", operation, retryability: "reinitialize" });
            case "QuotaExceededError":
                return new WebEventIndexError({ code: "storage_error", operation, retryability: "user_action" });
            case "VersionError":
                return new WebEventIndexError({ code: "version_incompatible", operation, retryability: "user_action" });
            case "AbortError":
                return new WebEventIndexError({ code: "cancelled", operation, retryability: "never" });
            default:
                return new WebEventIndexError({ code: "unknown", operation, retryability: "never" });
        }
    }

    /** Decode only a validated safe error envelope. */
    public static fromPayload(value: unknown): WebEventIndexError | null {
        if (!value || typeof value !== "object") return null;
        const payload = value as Partial<WebEventIndexErrorPayload>;
        if (
            typeof payload.code !== "string" ||
            !ERROR_CODES.has(payload.code) ||
            typeof payload.operation !== "string" ||
            !ERROR_OPERATIONS.has(payload.operation) ||
            typeof payload.retryability !== "string" ||
            !RETRYABILITIES.has(payload.retryability)
        ) {
            return null;
        }
        return new WebEventIndexError(payload as WebEventIndexErrorPayload);
    }

    /** Return only safe fields suitable for structured logging or postMessage. */
    public toPayload(): WebEventIndexErrorPayload {
        return { code: this.code, operation: this.operation, retryability: this.retryability };
    }
}
