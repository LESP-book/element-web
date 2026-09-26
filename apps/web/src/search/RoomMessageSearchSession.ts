/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ISearchResults, MatrixClient, SearchResult } from "matrix-js-sdk/src/matrix";

import { searchPagination, type ISeshatSearchResults } from "../Searching";
import type { IBackfillResult } from "../indexing/EventIndex";
import EventIndexPeg from "../indexing/EventIndexPeg";
import { MatrixClientPeg } from "../MatrixClientPeg";
import PlatformPeg from "../PlatformPeg";
import { WebEventIndexError } from "../indexing/web/WebEventIndexError";

const BACKFILL_LIMIT = 1000;

function sortResults(a: SearchResult, b: SearchResult): number {
    const first = a.context.getEvent();
    const second = b.context.getEvent();
    return second.getTs() - first.getTs() || (first.getId() ?? "").localeCompare(second.getId() ?? "");
}

function mergeResults(previous: ISearchResults, next: ISearchResults, countIsExact: boolean): ISearchResults {
    const results = new Map<string, SearchResult>();
    for (const result of [...previous.results, ...next.results]) {
        const event = result.context.getEvent();
        results.set(`${event.getRoomId()}/${event.getId()}`, result);
    }
    const merged = [...results.values()].sort(sortResults);
    return { ...next, results: merged, count: countIsExact ? (next.count ?? previous.count) : merged.length };
}

// Only this adapter interprets the Web worker cursor. Server and Seshat tokens are opaque.
function isWebScanExhausted(token?: string): boolean {
    if (!token) return false;
    try {
        const value: unknown = JSON.parse(token);
        return typeof value === "object" && value !== null && "exhausted" in value && value.exhausted === true;
    } catch {
        return false;
    }
}

/** Owns a single message query's provider cursor, results and history budget. */
export class RoomMessageSearchSession {
    private results: ISearchResults | null = null;
    private disposed = false;
    private paused = false;
    private stopEpoch = 0;
    private loading: { epoch: number; promise: Promise<ISearchResults | null> } | null = null;
    private historyCanContinue = true;
    private historyBlocked = false;
    private backfillRefreshPending = false;
    private historyRetryPending = false;
    private retryableHistoryError = false;
    private accessLimited = false;
    private readonly index = EventIndexPeg.get();
    private readonly webLocal = Boolean(
        PlatformPeg.get()?.getEventIndexingManager()?.supportsLocalUnencryptedRoomSearch(),
    );

    public constructor(
        private readonly client: MatrixClient,
        private readonly roomId?: string,
    ) {}

    /** First page is produced by Searching's capability router. */
    public acceptInitial(results: ISearchResults): ISearchResults | null {
        if (this.disposed || EventIndexPeg.get() !== this.index || MatrixClientPeg.get() !== this.client) return null;
        this.results = results;
        return results;
    }

    /** Server counts are exact; local counts describe only the currently scanned range. */
    public get countIsExact(): boolean {
        return this.results !== null && !Boolean((this.results as ISeshatSearchResults).seshatQuery);
    }

    public get current(): ISearchResults | null {
        return this.results;
    }

    public get isCurrentAccount(): boolean {
        return EventIndexPeg.get() === this.index && MatrixClientPeg.get() === this.client;
    }

    /** Automatic scrolling can read local pages, but must not fetch room history. */
    public get hasMoreLocal(): boolean {
        const results = this.results;
        return Boolean(
            results &&
            !this.paused &&
            this.isWebLocal(results) &&
            results.next_batch &&
            !isWebScanExhausted(results.next_batch),
        );
    }

    /** Stop after the current operation without cancelling another consumer's shared history write. */
    public stop(): void {
        this.paused = true;
        this.stopEpoch++;
    }

    /** Continue from the last committed cursor. */
    public resume(): void {
        if (!this.disposed) this.paused = false;
    }

    public get hasStopped(): boolean {
        return this.paused;
    }

    public get hasMore(): boolean {
        const results = this.results;
        if (!results || this.disposed || this.paused) return false;
        const web = this.isWebLocal(results);
        if (results.next_batch && (!web || !isWebScanExhausted(results.next_batch))) return true;
        return (
            web &&
            Boolean(results.next_batch) &&
            (this.backfillRefreshPending ||
                this.historyRetryPending ||
                (!this.historyBlocked && !this.accessLimited && this.historyCanContinue))
        );
    }

    /** A room-history cursor failure, not a claim that the room is complete. */
    public get needsHistoryRetry(): boolean {
        return this.historyBlocked;
    }

    /** A 403 ends the accessible range, not the room's full history. */
    public get isAccessLimited(): boolean {
        return this.accessLimited;
    }

    /** Retry room history only when EventIndex reported a retryable failure and continuation. */
    public retryHistory(): boolean {
        if (!this.retryableHistoryError || this.accessLimited) return false;
        this.historyBlocked = false;
        this.historyRetryPending = true;
        this.retryableHistoryError = false;
        return true;
    }

    private isWebLocal(results: ISearchResults): boolean {
        return this.webLocal && Boolean(this.roomId) && Boolean((results as ISeshatSearchResults).seshatQuery);
    }

    private assertAccount(): void {
        if (EventIndexPeg.get() !== this.index || MatrixClientPeg.get() !== this.client) {
            throw new Error("Event index account changed");
        }
    }

    /** Pages are bounded; an empty scan page still advances the worker cursor. */
    public loadMore(
        pages: number,
        onBackfill?: (running: boolean) => void,
        allowBackfill = true,
        onPage?: (results: ISearchResults) => void,
    ): Promise<ISearchResults | null> {
        if (this.loading) {
            if (this.loading.epoch === this.stopEpoch) return this.loading.promise;
            return this.loading.promise.then(
                () => this.loadMore(pages, onBackfill, allowBackfill, onPage),
                () => this.loadMore(pages, onBackfill, allowBackfill, onPage),
            );
        }
        const epoch = this.stopEpoch;
        const request = this.loadMoreInternal(pages, epoch, onBackfill, allowBackfill, onPage);
        const result = request.finally(() => {
            if (this.loading?.promise === result) this.loading = null;
        });
        this.loading = { epoch, promise: result };
        return result;
    }

    private async loadMoreInternal(
        pages: number,
        epoch: number,
        onBackfill?: (running: boolean) => void,
        allowBackfill = true,
        onPage?: (results: ISearchResults) => void,
    ): Promise<ISearchResults | null> {
        if (this.disposed || !this.results || this.paused) return this.results;
        let remaining = pages;
        while (remaining-- > 0 && this.hasMore && epoch === this.stopEpoch) {
            this.assertAccount();
            const current = this.results;
            const web = this.isWebLocal(current);
            if (web && isWebScanExhausted(current.next_batch)) {
                if (!allowBackfill) break;
                if (!this.index || !this.roomId || EventIndexPeg.get() !== this.index)
                    throw new Error("Event index unavailable");
                if (!this.backfillRefreshPending) {
                    onBackfill?.(true);
                    this.historyRetryPending = false;
                    try {
                        let backfill: IBackfillResult;
                        try {
                            backfill = await this.index.backfillRoom(this.roomId, BACKFILL_LIMIT);
                        } catch (error) {
                            this.historyBlocked = true;
                            // A rejected RPC has no canContinue outcome to authorize an explicit retry.
                            this.retryableHistoryError = false;
                            throw WebEventIndexError.from(error, "backfill");
                        }
                        if (this.disposed) return null;
                        const cursorFailed = backfill.reason === "missing_token" || backfill.reason === "stalled";
                        this.historyCanContinue = backfill.canContinue;
                        this.retryableHistoryError = false;
                        this.historyBlocked = cursorFailed;
                        if (backfill.error && !cursorFailed) {
                            const backfillError = WebEventIndexError.from(backfill.error, "backfill");
                            this.historyBlocked = true;
                            this.retryableHistoryError =
                                backfillError.code === "network_failure" && backfillError.retryability === "retry";
                            throw backfillError;
                        }
                        this.backfillRefreshPending = true;
                        this.accessLimited ||= backfill.reason === "forbidden";
                        if (epoch !== this.stopEpoch) return this.results;
                    } finally {
                        if (!this.disposed) onBackfill?.(false);
                    }
                }
                // Consume even a final or cursor-less batch before allowing another room-history step.
                const next = await searchPagination(this.client, current, this.index);
                if (this.disposed) return null;
                if (epoch !== this.stopEpoch) return this.results;
                this.assertAccount();
                this.results = mergeResults(current, next, this.countIsExact);
                this.backfillRefreshPending = false;
                this.retryableHistoryError = false;
            } else {
                const previousToken = current.next_batch;
                const previousCount = current.results.length;
                const next = await searchPagination(this.client, current, this.index);
                if (this.disposed) return null;
                if (epoch !== this.stopEpoch) return this.results;
                this.assertAccount();
                this.results = mergeResults(current, next, this.countIsExact);
                if (this.results.next_batch === previousToken && this.results.results.length === previousCount) break;
            }
            // Publish the committed cursor and matches before awaiting the next provider step.
            onPage?.(this.results);
        }
        return this.disposed ? null : this.results;
    }

    public dispose(): void {
        this.disposed = true;
    }
}
