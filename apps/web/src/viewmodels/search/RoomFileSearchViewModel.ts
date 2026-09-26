/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BaseViewModel } from "@element-hq/web-shared-components";
import type { MatrixEvent } from "matrix-js-sdk/src/matrix";

import { MatrixClientPeg } from "../../MatrixClientPeg";
import PlatformPeg from "../../PlatformPeg";
import EventIndexPeg from "../../indexing/EventIndexPeg";
import { _t } from "../../languageHandler";
import { RoomFileSearchSession, type RoomFileSearchPage } from "../../search/RoomFileSearchSession";
import { WebEventIndexError } from "../../indexing/web/WebEventIndexError";
import type { RoomFileSearchFilters } from "../../search/RoomFileSearchFilters";
import { roomFileSearchDateBounds } from "../../search/RoomFileSearchDates";

/** The attachment query's state, separate from the panel's legacy Timeline wiring. */
export interface RoomFileSearchSnapshot {
    events: MatrixEvent[];
    activeTab: "media" | "files";
    searchTerm: string;
    filters: RoomFileSearchFilters;
    loading: boolean;
    exhausted: boolean;
    accessLimited: boolean;
    stopped: boolean;
    draftPending: boolean;
    localPagesRemaining: boolean;
    error?: WebEventIndexError | Error;
    scanned: number;
    filterInvalid: boolean;
    status: string;
}

/** Owns attachment request generations, session continuation and result state. */
export class RoomFileSearchViewModel extends BaseViewModel<RoomFileSearchSnapshot, Record<string, never>> {
    private session: RoomFileSearchSession | null = null;
    private readonly tabs = new Map<
        "media" | "files",
        { session: RoomFileSearchSession; error?: Error; wasSearching: boolean; wasStopped: boolean }
    >();
    private eventById = new Map<string, MatrixEvent>();
    private generation = 0;
    private roomId = "";
    private filterTimer: ReturnType<typeof setTimeout> | null = null;

    public constructor() {
        super(
            {},
            {
                events: [],
                activeTab: "files",
                searchTerm: "",
                filters: { sender: "", fromDate: "", toDate: "", type: "all" },
                loading: true,
                exhausted: false,
                accessLimited: false,
                stopped: false,
                draftPending: false,
                localPagesRemaining: false,
                scanned: 0,
                filterInvalid: false,
                status: _t("file_panel|searching"),
            },
        );
    }

    private update(next: Partial<RoomFileSearchSnapshot>): void {
        const state = { ...this.getSnapshot(), ...next };
        if (next.events)
            this.eventById = new Map(
                next.events.flatMap((event) => {
                    const id = event.getId();
                    return id ? [[id, event] as const] : [];
                }),
            );
        const status = state.draftPending
            ? _t("file_panel|search_waiting")
            : state.stopped
              ? _t("file_panel|search_stopped")
              : state.loading
                ? _t("file_panel|searching")
                : state.accessLimited
                  ? _t("file_panel|history_access_limited")
                  : state.exhausted
                    ? _t("file_panel|search_complete")
                    : _t("file_panel|search_incomplete");
        this.snapshot.merge({ ...next, status, localPagesRemaining: Boolean(this.session?.hasMoreLocal) });
    }

    /** Look up a visible tile without scanning all accumulated results during virtualized scrolling. */
    public getEvent = (eventId: string): MatrixEvent | undefined => this.eventById.get(eventId);

    /** Change room/category/query; stale requests cannot commit a newer query's state. */
    public reset = async (roomId: string, activeTab: "media" | "files", searchTerm: string): Promise<void> => {
        if (this.filterTimer) clearTimeout(this.filterTimer);
        this.filterTimer = null;
        const previousRoomId = this.roomId;
        const previous = this.getSnapshot();
        const filters =
            roomId !== previousRoomId
                ? { sender: "", fromDate: "", toDate: "", type: "all" as const }
                : previous.filters.type === "all" ||
                    (activeTab === "media" ? ["m.image", "m.video"] : ["m.file", "m.audio"]).includes(
                        previous.filters.type,
                    )
                  ? previous.filters
                  : { ...previous.filters, type: "all" as const };
        const keepTabs =
            roomId === previousRoomId &&
            searchTerm === previous.searchTerm &&
            JSON.stringify(filters) === JSON.stringify(previous.filters) &&
            !previous.draftPending &&
            this.session !== null;
        if (keepTabs && activeTab === previous.activeTab) return;
        const generation = ++this.generation;
        this.roomId = roomId;
        if (!keepTabs) {
            this.session?.dispose();
            for (const entry of this.tabs.values()) entry.session.dispose();
            this.tabs.clear();
        } else if (this.session) {
            this.session.stop();
            this.tabs.set(previous.activeTab, {
                session: this.session,
                error: previous.error,
                wasSearching: previous.loading,
                wasStopped: previous.stopped,
            });
        }
        const cached = keepTabs ? this.tabs.get(activeTab) : undefined;
        if (cached) {
            this.session = cached.session;
            if (!cached.wasStopped) this.session.refreshIndexedResults();
            const resumed = !cached.wasStopped && this.session.resume();
            this.tabs.delete(activeTab);
            this.update({
                events:
                    cached.wasStopped || this.session.hasPendingOperation ? this.session.current : this.session.visible,
                activeTab,
                searchTerm,
                filters,
                scanned: this.session.scannedCount,
                loading: false,
                stopped: !resumed,
                exhausted: resumed && !this.session.hasMore && !this.session.isAccessLimited && !cached.error,
                accessLimited: this.session.isAccessLimited,
                error: cached.wasStopped ? cached.error : resumed ? cached.error : this.pendingOperationError(),
            });
            if (resumed && (cached.wasSearching || this.session.isIndexedQuery) && this.session.hasMore)
                await this.loadMore(true, generation);
            return;
        }
        const client = MatrixClientPeg.safeGet();
        const room = client.getRoom(roomId);
        const index = EventIndexPeg.get();
        const supportsFiltered = Boolean(PlatformPeg.get()?.getEventIndexingManager()?.supportsFilteredFileQuery());
        this.session =
            room && index
                ? new RoomFileSearchSession(client, room, index, activeTab, searchTerm, supportsFiltered, filters)
                : null;
        this.update({
            events: [],
            activeTab,
            searchTerm,
            filters,
            scanned: 0,
            loading: true,
            exhausted: false,
            accessLimited: false,
            stopped: false,
            draftPending: false,
            filterInvalid: false,
            error: undefined,
        });
        if (roomFileSearchDateBounds(filters) === null) {
            this.session?.dispose();
            this.session = null;
            this.update({ loading: false, filterInvalid: true, error: new Error(_t("file_panel|invalid_date_range")) });
            return;
        }
        await this.loadMore(true, generation);
    };

    /** A changed filter starts a new session and invalidates its cursor. */
    public setFilters = (change: Partial<RoomFileSearchFilters>): void => {
        if (this.isDisposed) return;
        const state = this.getSnapshot();
        for (const entry of this.tabs.values()) entry.session.dispose();
        this.tabs.clear();
        this.session?.dispose();
        this.session = null;
        this.snapshot.merge({ filters: { ...state.filters, ...change } });
        if (this.filterTimer) clearTimeout(this.filterTimer);
        this.filterTimer = null;
        if (change.sender !== undefined) {
            this.invalidateDraft();
            this.filterTimer = setTimeout(() => {
                this.filterTimer = null;
                void this.reset(this.roomId, state.activeTab, state.searchTerm);
            }, 300);
        } else {
            void this.reset(this.roomId, state.activeTab, state.searchTerm);
        }
    };

    /** Stop an old query immediately when the input changes; its next page cannot commit. */
    public invalidateDraft = (): void => {
        this.generation++;
        this.session?.stop();
        this.update({
            events: [],
            loading: false,
            exhausted: false,
            stopped: false,
            draftPending: true,
            error: undefined,
        });
    };

    /** Run one foreground search task across bounded provider steps, publishing each committed page. */
    public loadMore = async (initial = false, generation = this.generation, allowBackfill = true): Promise<boolean> => {
        const state = this.getSnapshot();
        if ((!initial && state.loading) || state.exhausted || state.stopped || state.draftPending || this.isDisposed)
            return false;
        const session = this.session;
        if (!session) {
            this.update({ error: new Error(_t("file_panel|index_unavailable")), exhausted: true, loading: false });
            return false;
        }
        const current = (): boolean => !this.isDisposed && generation === this.generation && this.session === session;
        const publish = (page: RoomFileSearchPage): void => {
            if (!current()) return;
            this.update({
                events: page.error ? session.current : session.visible,
                scanned: page.scanned,
                exhausted: !page.hasMore && !page.error && !page.accessLimited,
                accessLimited: Boolean(page.accessLimited),
                error: page.error,
                stopped: page.error?.code === "connection_blocked" ? true : this.getSnapshot().stopped,
            });
        };
        this.update({ loading: true, error: undefined });
        try {
            const page = await session.searchUntilTarget(allowBackfill, publish);
            if (!current()) return false;
            publish(page);
            return session.hasMore;
        } catch (error) {
            if (current()) this.update({ error: WebEventIndexError.from(error, "queryFileEvents") });
            return false;
        } finally {
            if (current()) this.update({ loading: false });
        }
    };

    /** Scroll only local index pages; leave network history behind the explicit Show more action. */
    public loadMoreLocal = (): void => {
        if (this.session?.hasMoreLocal) void this.loadMore(false, this.generation, false);
    };

    /** Retry only a history outcome which explicitly allows it; local page failures retain their cursor. */
    public retry = (): void => {
        if (this.getSnapshot().filterInvalid) return;
        this.session?.retryHistory();
        void this.loadMore();
    };

    public stop = (): void => {
        if (this.getSnapshot().draftPending) return;
        this.generation++;
        this.session?.stop();
        this.update({ loading: false, stopped: true });
    };

    private pendingOperationError(): WebEventIndexError {
        return new WebEventIndexError({ code: "connection_blocked", operation: "rpc", retryability: "user_action" });
    }

    public resume = (): void => {
        if (this.getSnapshot().draftPending) return;
        this.session?.refreshIndexedResults();
        if (!this.session?.resume()) {
            this.update({ loading: false, stopped: true, error: this.pendingOperationError() });
            return;
        }
        this.update({ stopped: false, error: undefined });
        void this.loadMore();
    };

    /** The legacy Timeline listener passes live events through the current query identity. */
    public addLiveEvent = (event: MatrixEvent): void => {
        if (this.getSnapshot().draftPending) return;
        for (const entry of this.tabs.values()) entry.session.add(event);
        if (this.session) this.update({ events: this.session.add(event) });
    };

    public redactEvent = (eventId: string | undefined): void => {
        if (!eventId) return;
        for (const entry of this.tabs.values()) entry.session.redact(eventId);
        if (this.session) this.update({ events: this.session.redact(eventId) });
    };

    public replaceEvent = (target: string | undefined, content: Record<string, unknown>, edit: MatrixEvent): void => {
        if (!target) return;
        for (const entry of this.tabs.values()) entry.session.edit(target, content, edit);
        if (this.session) this.update({ events: this.session.edit(target, content, edit) });
    };

    public override dispose(): void {
        if (this.filterTimer) clearTimeout(this.filterTimer);
        this.generation++;
        this.session?.dispose();
        for (const entry of this.tabs.values()) entry.session.dispose();
        this.tabs.clear();
        super.dispose();
    }
}
