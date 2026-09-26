/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventTimeline, MatrixEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import type EventIndex from "../indexing/EventIndex";
import EventIndexPeg from "../indexing/EventIndexPeg";
import { MatrixClientPeg } from "../MatrixClientPeg";
import { WebEventIndexError } from "../indexing/web/WebEventIndexError";
import { matchesRoomFileSearchEvent } from "./matchesRoomFileSearchEvent";
import type { RoomFileSearchFilters } from "./RoomFileSearchFilters";
import { roomFileSearchDateBounds } from "./RoomFileSearchDates";
import { getOriginalFileEvent } from "./RoomFileSearchOriginals";

const BATCH_SIZE = 50;
const MAX_SCAN_PAGES = 3;
const BACKFILL_LIMIT = 500;
const MAX_BACKFILL_PAGES_PER_LOAD = 1;
const TASK_BUDGET_MS = 8_000;
const OPERATION_WAIT_MS = 8_000;

/** Accumulated attachment results and their recoverable continuation state. */
export interface RoomFileSearchPage {
    events: MatrixEvent[];
    hasMore: boolean;
    cursorFailed?: boolean;
    accessLimited?: boolean;
    error?: WebEventIndexError;
    scanned: number;
}

/** A bounded attachment search with cumulative, retry-safe result ownership. */
export class RoomFileSearchSession {
    private cursor?: string;
    private exhaustedLocal = false;
    private historyCanContinue = true;
    private historyBlocked = false;
    private retryableBackfill = false;
    private backfillRetryPending = false;
    private localQueryPending = false;
    private accessLimited = false;
    private disposed = false;
    private paused = false;
    private rescanOnResume = false;
    private stopEpoch = 0;
    private timelinePrepared = false;
    private readonly filteredIndex: boolean;
    private readonly results = new Map<string, MatrixEvent>();
    private readonly originals = new Map<string, MatrixEvent>();
    private readonly edits = new Map<string, Map<string, { event: MatrixEvent; content: Record<string, unknown> }>>();
    private readonly editTargets = new Map<string, string>();
    private readonly indexedEdits = new Map<string, Set<string>>();
    private readonly indexedResults = new Set<string>();
    private rescanSeen: Set<string> | null = null;
    private readonly rescanCandidates = new Map<string, MatrixEvent>();
    private readonly liveEdits = new Set<string>();
    private readonly liveOriginals = new Set<string>();
    private readonly redacted = new Set<string>();
    private scanned = 0;
    private loading: { epoch: number; promise: Promise<RoomFileSearchPage> } | null = null;
    private lastError: WebEventIndexError | undefined;
    private activeOperation: "rpc" | "backfill" | "queryFileEvents" | "loadFileEvents" = "rpc";

    public constructor(
        private readonly client: MatrixClient,
        private readonly room: Room,
        private readonly index: EventIndex,
        private readonly category: "media" | "files",
        private readonly term: string,
        filteredIndex = false,
        private readonly filters?: RoomFileSearchFilters,
    ) {
        this.filteredIndex = filteredIndex;
    }

    /** Whether the provider can filter by category and filename in the index. */
    public get isIndexedQuery(): boolean {
        return this.filteredIndex;
    }

    public get current(): MatrixEvent[] {
        return this.sortedResults();
    }

    /** Hide unverified indexed matches while keeping them available if the refresh fails. */
    public get visible(): MatrixEvent[] {
        if (!this.rescanSeen) return this.current;
        return this.current.filter((event) => {
            const id = event.getId()!;
            return !this.indexedResults.has(id) || this.hasLiveRevision(id);
        });
    }

    private hasLiveRevision(id: string): boolean {
        return (
            this.liveOriginals.has(id) || [...(this.edits.get(id)?.keys() ?? [])].some((key) => this.liveEdits.has(key))
        );
    }

    public get scannedCount(): number {
        return this.scanned;
    }

    public get hasMore(): boolean {
        return (
            !this.disposed &&
            !this.paused &&
            (this.localQueryPending ||
                this.backfillRetryPending ||
                (!this.historyBlocked && !this.accessLimited && (!this.exhaustedLocal || this.historyCanContinue)))
        );
    }

    public get isAccessLimited(): boolean {
        return this.accessLimited;
    }

    /** Whether a scroll-triggered load can read local pages without starting room-history backfill. */
    public get hasMoreLocal(): boolean {
        return !this.disposed && !this.paused && (this.localQueryPending || !this.exhaustedLocal);
    }

    /** Resume room history only when EventIndex returned an explicitly retryable backfill outcome. */
    public retryHistory(): boolean {
        if (!this.retryableBackfill || this.accessLimited) return false;
        this.historyBlocked = false;
        this.retryableBackfill = false;
        this.backfillRetryPending = true;
        this.lastError = undefined;
        return true;
    }

    /** Stop starting new pages without cancelling a shared room-history write. */
    public stop(): void {
        this.cancelIndexedRefresh();
        this.rescanOnResume ||= this.loading !== null;
        this.paused = true;
        this.stopEpoch++;
    }

    /** Resume only after an unsettled operation has finished; never race its cursor or shared write. */
    public resume(): boolean {
        if (this.disposed || this.loading) return false;
        this.paused = false;
        if (this.rescanOnResume) {
            this.cursor = undefined;
            this.exhaustedLocal = false;
            this.localQueryPending = true;
            this.rescanOnResume = false;
        }
        return true;
    }

    public get hasPendingOperation(): boolean {
        return this.loading !== null;
    }

    private get ownerValid(): boolean {
        return (
            !this.disposed &&
            MatrixClientPeg.get() === this.client &&
            EventIndexPeg.get() === this.index &&
            this.client.getRoom(this.room.roomId) === this.room
        );
    }

    private get active(): boolean {
        return !this.paused && this.ownerValid;
    }

    /** Stage an indexed re-scan without discarding already committed matches on failure. */
    public refreshIndexedResults(): void {
        if (!this.filteredIndex || this.loading) return;
        this.cursor = undefined;
        this.exhaustedLocal = false;
        this.localQueryPending = true;
        this.rescanOnResume = true;
        this.rescanCandidates.clear();
        this.rescanSeen = new Set();
    }

    private cancelIndexedRefresh(): void {
        this.rescanSeen = null;
        this.rescanCandidates.clear();
    }

    private finishIndexedRefresh(): void {
        const seen = this.rescanSeen;
        if (!seen) return;
        for (const id of this.indexedResults) {
            if (seen.has(id)) continue;
            for (const editId of this.indexedEdits.get(id) ?? []) {
                if (this.liveEdits.has(editId)) continue;
                this.edits.get(id)?.delete(editId);
                this.editTargets.delete(editId);
            }
            this.indexedEdits.delete(id);
            if (!this.hasLiveRevision(id)) {
                this.originals.delete(id);
                this.results.delete(id);
            } else {
                this.project(id);
            }
            this.indexedResults.delete(id);
        }
        const candidates = [...this.rescanCandidates.values()];
        this.cancelIndexedRefresh();
        for (const event of candidates) this.accept(event, true);
    }

    /** Withdraw an original permanently, or re-project it when one of its edits is redacted. */
    public redact(eventId: string): MatrixEvent[] {
        this.redacted.add(eventId);
        const target = this.editTargets.get(eventId);
        if (target) {
            this.edits.get(target)?.delete(eventId);
            this.project(target);
        } else {
            this.originals.delete(eventId);
            this.results.delete(eventId);
            this.edits.delete(eventId);
        }
        return this.sortedResults();
    }

    /** Remember an edit even if its target is not in the query's visible results yet. */
    public edit(target: string, content: Record<string, unknown>, editEvent: MatrixEvent): MatrixEvent[] {
        this.recordEdit(target, content, editEvent, true);
        return this.sortedResults();
    }

    private recordEdit(target: string, content: Record<string, unknown>, editEvent: MatrixEvent, live: boolean): void {
        const id = editEvent.getId();
        if (!id || this.redacted.has(id) || this.redacted.has(target)) return;
        const original = this.originals.get(target);
        if (
            original &&
            (original.getRoomId() !== editEvent.getRoomId() ||
                original.getSender() !== editEvent.getSender() ||
                original.getType() !== editEvent.getType())
        )
            return;
        if (this.editTargets.has(id)) {
            if (live) this.liveEdits.add(id);
            return;
        }
        if (live) this.liveEdits.add(id);
        this.editTargets.set(id, target);
        let revisions = this.edits.get(target);
        if (!revisions) {
            revisions = new Map();
            this.edits.set(target, revisions);
        }
        revisions.set(id, { event: editEvent, content });
        this.project(target);
    }

    private makeProjectedEvent(original: MatrixEvent, content: Record<string, unknown>): MatrixEvent {
        // Decrypted MatrixEvents keep their clear type outside the raw encrypted event payload.
        const originalContent = original.getContent<Record<string, unknown>>();
        const projectedContent = { ...content };
        if (content.url === undefined && originalContent.url !== undefined) projectedContent.url = originalContent.url;
        const originalFile = originalContent.file;
        const projectedFile = content.file;
        if (projectedFile === undefined && originalFile !== undefined) {
            projectedContent.file = originalFile;
        } else if (
            typeof originalFile === "object" &&
            originalFile !== null &&
            typeof projectedFile === "object" &&
            projectedFile !== null
        ) {
            projectedContent.file = { ...originalFile, ...projectedFile };
        }
        const originalInfo = originalContent.info;
        const projectedInfo = content.info;
        if (projectedInfo === undefined && originalInfo !== undefined) {
            projectedContent.info = originalInfo;
        } else if (
            typeof originalInfo === "object" &&
            originalInfo !== null &&
            typeof projectedInfo === "object" &&
            projectedInfo !== null
        ) {
            projectedContent.info = { ...originalInfo, ...projectedInfo };
        }
        return new MatrixEvent({ ...original.event, type: original.getType(), content: projectedContent });
    }

    private project(id: string): void {
        const original = this.originals.get(id);
        if (!original || this.redacted.has(id)) return;
        const latest = [...(this.edits.get(id)?.values() ?? [])]
            .filter(
                ({ event }) =>
                    event.getRoomId() === original.getRoomId() &&
                    event.getSender() === original.getSender() &&
                    event.getType() === original.getType(),
            )
            .sort(
                (a, b) =>
                    a.event.getTs() - b.event.getTs() || (a.event.getId() ?? "").localeCompare(b.event.getId() ?? ""),
            )
            .at(-1);
        const projected = latest ? this.makeProjectedEvent(original, latest.content) : original;
        if (this.matches(projected)) this.results.set(id, projected);
        else this.results.delete(id);
    }

    private accept(event: MatrixEvent, indexedPage = false): boolean {
        const id = event.getId();
        if (!id || this.redacted.has(id)) return false;
        if (indexedPage && this.rescanSeen) {
            this.rescanSeen.add(id);
            this.rescanCandidates.set(id, event);
            return false;
        }
        const indexed = getOriginalFileEvent(event);
        const original = indexed?.original ?? event;
        const msgtype = event.getContent().msgtype;
        if (typeof msgtype !== "string" || !["m.file", "m.audio", "m.image", "m.video"].includes(msgtype)) return false;
        if (!this.originals.has(id)) this.originals.set(id, original);
        if (indexedPage) {
            this.indexedResults.add(id);
            this.rescanSeen?.add(id);
        } else this.liveOriginals.add(id);
        if (indexed) {
            const ids = new Set((indexed.edits ?? []).map((revision) => revision.event_id));
            for (const prior of this.indexedEdits.get(id) ?? []) {
                if (!ids.has(prior) && !this.liveEdits.has(prior)) {
                    this.edits.get(id)?.delete(prior);
                    this.editTargets.delete(prior);
                }
            }
            this.indexedEdits.set(id, ids);
        }
        for (const revision of indexed?.edits ?? []) {
            this.recordEdit(
                id,
                revision.content,
                new MatrixEvent({
                    event_id: revision.event_id,
                    room_id: revision.room_id,
                    sender: revision.sender,
                    origin_server_ts: revision.timestamp,
                    type: original.getType(),
                }),
                false,
            );
        }
        this.project(id);
        return this.results.has(id);
    }

    /** Add a live attachment through the same revision projection as scanned pages. */
    public add(event: MatrixEvent): MatrixEvent[] {
        this.accept(event);
        return this.sortedResults();
    }

    private sortedResults(): MatrixEvent[] {
        return [...this.results.values()].sort(
            (first, second) =>
                second.getTs() - first.getTs() || (second.getId() ?? "").localeCompare(first.getId() ?? ""),
        );
    }

    /** Continue bounded steps until a first-screen target, deadline or explicit stop. */
    public async searchUntilTarget(
        allowBackfill = true,
        onPage?: (page: RoomFileSearchPage) => void,
    ): Promise<RoomFileSearchPage> {
        const epoch = this.stopEpoch;
        const started = performance.now();
        const refreshing = this.rescanSeen !== null;
        const target = refreshing ? Number.POSITIVE_INFINITY : this.results.size + 20;
        const step = async (): Promise<RoomFileSearchPage> => {
            const remaining = TASK_BUDGET_MS - (performance.now() - started);
            if (remaining <= 0) return { events: this.sortedResults(), hasMore: this.hasMore, scanned: this.scanned };
            const operation = this.loadMore(allowBackfill && !refreshing, onPage);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([
                    operation,
                    new Promise<null>((resolve) => {
                        timer = setTimeout(() => resolve(null), Math.min(OPERATION_WAIT_MS, Math.max(0, remaining)));
                    }),
                ]);
                if (result) return result;
                // The underlying operation remains owned by this session; resume must not start a competing cursor.
                this.stop();
                return {
                    events: this.sortedResults(),
                    hasMore: false,
                    scanned: this.scanned,
                    error: new WebEventIndexError({
                        code: "connection_blocked",
                        operation: this.activeOperation,
                        retryability: "user_action",
                    }),
                };
            } finally {
                clearTimeout(timer);
            }
        };
        let page = await step();
        if (!allowBackfill || (refreshing && this.rescanSeen === null)) return page;
        while (
            epoch === this.stopEpoch &&
            this.hasMore &&
            !page.error &&
            this.results.size < target &&
            performance.now() - started < TASK_BUDGET_MS
        ) {
            // Give input and paint a chance between Worker/network batches.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (epoch !== this.stopEpoch || !this.hasMore) break;
            page = await step();
            if (refreshing && this.rescanSeen === null) break;
        }
        if (refreshing && this.rescanSeen && epoch === this.stopEpoch) {
            // A partial scan is not authoritative; retain previously committed indexed matches.
            this.cancelIndexedRefresh();
            page = { ...page, events: this.current, hasMore: this.hasMore };
            onPage?.(page);
        }
        return page;
    }

    /** Read bounded local pages and at most one shared room-history page per step. */
    public loadMore(allowBackfill = true, onPage?: (page: RoomFileSearchPage) => void): Promise<RoomFileSearchPage> {
        if (this.loading) {
            if (this.loading.epoch === this.stopEpoch) return this.loading.promise;
            // A stopped shared write may still be finishing; never run a second scan concurrently.
            return this.loading.promise.then(
                () => this.loadMore(allowBackfill, onPage),
                () => this.loadMore(allowBackfill, onPage),
            );
        }
        const epoch = this.stopEpoch;
        const request = this.loadMoreInternal(epoch, allowBackfill, onPage);
        const result = request.finally(() => {
            if (this.loading?.promise === result) this.loading = null;
        });
        this.loading = { epoch, promise: result };
        return result;
    }

    private async loadMoreInternal(
        epoch: number,
        allowBackfill: boolean,
        onPage?: (page: RoomFileSearchPage) => void,
    ): Promise<RoomFileSearchPage> {
        if (!this.active) return { events: [], hasMore: false, scanned: this.scanned };
        let backfillPages = 0;
        let scans = 0;
        let batchMatches = 0;
        let cursorError: WebEventIndexError | undefined;
        let backfillOutcomeReceived = false;
        let operation: "backfill" | "queryFileEvents" | "loadFileEvents" = "queryFileEvents";
        if (!this.historyBlocked) this.lastError = undefined;

        try {
            if (!this.timelinePrepared) {
                this.activeOperation = "rpc";
                await this.index.ensureRoomTimelineIndexed?.(this.room.roomId);
                if (!this.active || epoch !== this.stopEpoch)
                    return { events: [], hasMore: false, scanned: this.scanned };
                this.timelinePrepared = true;
            }

            while (
                this.active &&
                epoch === this.stopEpoch &&
                batchMatches < BATCH_SIZE &&
                scans < MAX_SCAN_PAGES &&
                this.hasMore
            ) {
                if (this.exhaustedLocal && !this.localQueryPending) {
                    if (
                        !allowBackfill ||
                        (!this.historyCanContinue && !this.backfillRetryPending) ||
                        backfillPages >= MAX_BACKFILL_PAGES_PER_LOAD
                    ) {
                        break;
                    }
                    backfillPages++;
                    operation = "backfill";
                    this.activeOperation = operation;
                    this.backfillRetryPending = false;
                    // If stopped during this shared write, resume must first scan the newly indexed batch.
                    this.exhaustedLocal = false;
                    const backfill = await this.index.backfillRoom(this.room.roomId, BACKFILL_LIMIT);
                    backfillOutcomeReceived = true;
                    this.scanned += backfill.scanned;
                    if (!this.ownerValid) return { events: [], hasMore: false, scanned: this.scanned };
                    // The shared task can finish after stop/resume. Commit only its continuation facts, not an old query page.
                    const cursorFailed = backfill.reason === "missing_token" || backfill.reason === "stalled";
                    this.historyCanContinue = backfill.canContinue;
                    this.retryableBackfill = false;
                    this.accessLimited ||= backfill.reason === "forbidden";
                    if (backfill.error && !cursorFailed) {
                        const backfillError = WebEventIndexError.from(backfill.error, "backfill");
                        this.retryableBackfill =
                            backfillError.code === "network_failure" && backfillError.retryability === "retry";
                        this.historyBlocked = true;
                        this.lastError = backfillError;
                        if (!this.active || epoch !== this.stopEpoch)
                            return { events: [], hasMore: false, scanned: this.scanned };
                        throw backfillError;
                    }
                    if (cursorFailed && backfill.error instanceof WebEventIndexError) {
                        cursorError = backfill.error;
                    } else if (cursorFailed) {
                        cursorError = new WebEventIndexError({
                            code: "cursor_unavailable",
                            operation: "backfill",
                            retryability: "reinitialize",
                        });
                    }
                    if (cursorError) {
                        this.historyBlocked = true;
                        this.lastError = cursorError;
                    }
                    if (!this.active || epoch !== this.stopEpoch)
                        return { events: [], hasMore: false, scanned: this.scanned };
                    this.exhaustedLocal = false;
                    operation = this.filteredIndex ? "queryFileEvents" : "loadFileEvents";
                }

                if (this.filteredIndex) {
                    this.activeOperation = "queryFileEvents";
                    this.localQueryPending = true;
                    const bounds = this.filters ? roomFileSearchDateBounds(this.filters) : null;
                    const page = await this.index.queryFileEvents(this.room, {
                        category: this.category,
                        term: this.term,
                        limit: BATCH_SIZE - batchMatches,
                        cursor: this.cursor,
                        sender: this.filters?.sender.trim() || undefined,
                        fromTs: bounds?.fromTs,
                        toTs: bounds?.toTs,
                        msgtype: this.filters?.type === "all" ? undefined : this.filters?.type,
                    });
                    if (!this.active || epoch !== this.stopEpoch)
                        return { events: [], hasMore: false, scanned: this.scanned };
                    this.localQueryPending = false;
                    this.cursor = page.cursor ?? this.cursor;
                    this.exhaustedLocal = page.exhausted;
                    for (const event of page.events) {
                        if (this.accept(event, true)) batchMatches++;
                    }
                } else {
                    this.activeOperation = "loadFileEvents";
                    this.localQueryPending = true;
                    const page = await this.index.loadFileEvents(
                        this.room,
                        BATCH_SIZE,
                        this.cursor,
                        EventTimeline.BACKWARDS,
                    );
                    if (!this.active || epoch !== this.stopEpoch)
                        return { events: [], hasMore: false, scanned: this.scanned };
                    this.localQueryPending = false;
                    this.cursor = page.at(-1)?.getId() ?? this.cursor;
                    this.exhaustedLocal = page.length < BATCH_SIZE;
                    for (const event of page) {
                        if (this.accept(event, true)) batchMatches++;
                    }
                }
                scans++;
                onPage?.({ events: this.visible, hasMore: this.hasMore, scanned: this.scanned });

                if (cursorError) {
                    this.historyBlocked = true;
                    this.lastError = cursorError;
                    break;
                }
            }
        } catch (error) {
            if (epoch !== this.stopEpoch) return { events: [], hasMore: false, scanned: this.scanned };
            this.lastError = WebEventIndexError.from(error, operation);
            if (operation === "backfill") {
                this.historyBlocked = true;
                // A rejected RPC has no canContinue outcome to authorize an explicit retry.
                if (!backfillOutcomeReceived) this.retryableBackfill = false;
            }
        }

        if (this.active && this.exhaustedLocal && !this.localQueryPending && !this.lastError)
            this.finishIndexedRefresh();
        return {
            events: this.sortedResults(),
            hasMore: this.hasMore,
            cursorFailed: this.lastError?.code === "cursor_unavailable",
            accessLimited: this.accessLimited && !this.hasMore,
            error: this.lastError,
            scanned: this.scanned,
        };
    }

    private matches(event: MatrixEvent): boolean {
        return matchesRoomFileSearchEvent(event, this.category, this.term, this.filters);
    }

    public dispose(): void {
        this.disposed = true;
        this.results.clear();
        this.originals.clear();
        this.edits.clear();
        this.editTargets.clear();
        this.indexedEdits.clear();
        this.indexedResults.clear();
        this.cancelIndexedRefresh();
        this.liveEdits.clear();
        this.liveOriginals.clear();
        this.redacted.clear();
    }
}
