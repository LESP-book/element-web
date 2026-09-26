/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { mockPlatformPeg } from "test-utils";

import { RoomFileSearchViewModel } from "./RoomFileSearchViewModel";
import EventIndexPeg from "../../indexing/EventIndexPeg";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import type EventIndex from "../../indexing/EventIndex";

const room = { roomId: "!room:id" } as Room;
const client = { getRoom: () => room } as unknown as MatrixClient;
const makeFile = (id: string, name: string, msgtype = "m.file"): MatrixEvent =>
    new MatrixEvent({
        event_id: id,
        room_id: room.roomId,
        type: "m.room.message",
        sender: "@author:id",
        origin_server_ts: 10,
        content: { msgtype, filename: name, body: name },
    });

afterEach(() => vi.restoreAllMocks());

describe("RoomFileSearchViewModel", () => {
    it.each(["query", "timeline"] as const)(
        "ends a hanging %s step and waits for its owner before resume",
        async (kind) => {
            vi.useFakeTimers();
            try {
                mockPlatformPeg({
                    getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never,
                });
                vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
                vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
                const pending = Promise.withResolvers<void | { events: MatrixEvent[]; exhausted: boolean }>();
                const index = {
                    ensureRoomTimelineIndexed: vi
                        .fn()
                        .mockImplementation(() => (kind === "timeline" ? pending.promise : Promise.resolve())),
                    queryFileEvents: vi
                        .fn()
                        .mockResolvedValue({ events: [makeFile("$new", "report.pdf")], exhausted: true }),
                    backfillRoom: vi
                        .fn()
                        .mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
                } as unknown as EventIndex;
                if (kind === "query") vi.mocked(index.queryFileEvents).mockReturnValueOnce(pending.promise as never);
                vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
                const vm = new RoomFileSearchViewModel();
                const opening = vm.reset(room.roomId, "files", "report");
                await vi.advanceTimersByTimeAsync(8_001);
                await opening;
                expect(vm.getSnapshot()).toMatchObject({
                    loading: false,
                    stopped: true,
                    error: { code: "connection_blocked" },
                });
                vm.resume();
                expect(vm.getSnapshot()).toMatchObject({ loading: false, stopped: true });
                expect(index.queryFileEvents).toHaveBeenCalledTimes(kind === "query" ? 1 : 0);
                pending.resolve(
                    kind === "query"
                        ? { events: [makeFile("$stale", "report-stale.pdf")], exhausted: true }
                        : undefined,
                );
                await vi.advanceTimersByTimeAsync(0);
                expect(vm.getSnapshot().events).toEqual([]);
                vm.resume();
                await vi.advanceTimersByTimeAsync(0);
                expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$new"]);
                vm.dispose();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it("keeps a timed-out tab stopped after its pending query settles in the background", async () => {
        vi.useFakeTimers();
        try {
            mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
            vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
            vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
            const pending = Promise.withResolvers<{ events: MatrixEvent[]; exhausted: boolean }>();
            const index = {
                queryFileEvents: vi
                    .fn()
                    .mockImplementation((_: Room, query: { category: string }) =>
                        query.category === "media" ? Promise.resolve({ events: [], exhausted: true }) : pending.promise,
                    ),
                backfillRoom: vi
                    .fn()
                    .mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
            } as unknown as EventIndex;
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
            const vm = new RoomFileSearchViewModel();
            const opening = vm.reset(room.roomId, "files", "report");
            await vi.advanceTimersByTimeAsync(8_001);
            await opening;
            expect(vm.getSnapshot().stopped).toBe(true);
            await vm.reset(room.roomId, "media", "report");
            pending.resolve({ events: [], exhausted: true });
            await vi.advanceTimersByTimeAsync(0);
            await vm.reset(room.roomId, "files", "report");
            expect(vm.getSnapshot()).toMatchObject({ loading: false, stopped: true });
            expect(
                vi.mocked(index.queryFileEvents).mock.calls.filter(([, query]) => query.category === "files"),
            ).toHaveLength(1);
            vm.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("ends a hanging shared history step without issuing a second backfill", async () => {
        vi.useFakeTimers();
        try {
            mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
            vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
            vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
            const history = Promise.withResolvers<{
                scanned: number;
                indexed: number;
                exhausted: boolean;
                canContinue: boolean;
            }>();
            const index = {
                queryFileEvents: vi
                    .fn()
                    .mockResolvedValueOnce({ events: [], exhausted: true })
                    .mockResolvedValue({ events: [makeFile("$new", "report.pdf")], exhausted: true }),
                backfillRoom: vi.fn().mockReturnValue(history.promise),
            } as unknown as EventIndex;
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
            const vm = new RoomFileSearchViewModel();
            const opening = vm.reset(room.roomId, "files", "report");
            await vi.advanceTimersByTimeAsync(8_001);
            await opening;
            expect(vm.getSnapshot()).toMatchObject({
                loading: false,
                stopped: true,
                error: { code: "connection_blocked" },
            });
            vm.resume();
            expect(index.backfillRoom).toHaveBeenCalledOnce();
            history.resolve({ scanned: 500, indexed: 1, exhausted: true, canContinue: false });
            await vi.advanceTimersByTimeAsync(0);
            vm.resume();
            await vi.advanceTimersByTimeAsync(0);
            expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$new"]);
            expect(index.backfillRoom).toHaveBeenCalledOnce();
            vm.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should discard the old page when a second query replaces it", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const oldPage = Promise.withResolvers<{ events: MatrixEvent[]; cursor: string; exhausted: boolean }>();
        const currentFile = makeFile("$current", "new.pdf");
        const index = {
            queryFileEvents: vi
                .fn()
                .mockReturnValueOnce(oldPage.promise)
                .mockResolvedValueOnce({ events: [currentFile], cursor: "end", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: true, scanned: 0, indexed: 0, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const first = vm.reset(room.roomId, "files", "old");
        await vi.waitFor(() => expect(index.queryFileEvents).toHaveBeenCalledOnce());
        const second = vm.reset(room.roomId, "files", "new");
        await second;
        oldPage.resolve({ events: [makeFile("$old", "old.pdf")], cursor: "old", exhausted: true });
        await first;
        expect(vm.getSnapshot().searchTerm).toBe("new");
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$current"]);
        vm.dispose();
    });

    it("resumes the foreground task when switching back to an unfinished tab", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; exhausted: boolean }>();
        let fileReads = 0;
        const index = {
            queryFileEvents: vi.fn().mockImplementation((_: Room, query: { category: string }) => {
                if (query.category === "media") return Promise.resolve({ events: [], exhausted: true });
                return ++fileReads === 1
                    ? pending.promise
                    : Promise.resolve({ events: [makeFile("$return", "return.pdf")], exhausted: true });
            }),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const opening = vm.reset(room.roomId, "files", "");
        await vi.waitFor(() => expect(index.queryFileEvents).toHaveBeenCalledOnce());
        await vm.reset(room.roomId, "media", "");
        await vm.reset(room.roomId, "files", "");
        expect(vm.getSnapshot()).toMatchObject({ loading: false, stopped: true });
        expect(
            vi.mocked(index.queryFileEvents).mock.calls.filter(([, query]) => query.category === "files"),
        ).toHaveLength(1);
        pending.resolve({ events: [], exhausted: true });
        await opening;
        vm.resume();
        expect(
            vi.mocked(index.queryFileEvents).mock.calls.filter(([, query]) => query.category === "files"),
        ).toHaveLength(2);
        await vi.waitFor(() => expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$return"]));
        vm.dispose();
    });

    it("keeps an in-flight request alive when the same tab and query are selected again", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; exhausted: boolean }>();
        const index = {
            queryFileEvents: vi.fn().mockReturnValue(pending.promise),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const opening = vm.reset(room.roomId, "files", "report");
        await vi.waitFor(() => expect(index.queryFileEvents).toHaveBeenCalledOnce());
        await vm.reset(room.roomId, "files", "report");
        pending.resolve({ events: [makeFile("$found", "report.pdf")], exhausted: true });
        await opening;
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$found"]);
        expect(vm.getSnapshot().loading).toBe(false);
        vm.dispose();
    });

    it("should not restart history from repeated media scroll-end events after local exhaustion", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const files = Array.from({ length: 50 }, (_, i) => makeFile(`$page${i}`, `photo${i}.png`, "m.image"));
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: files, cursor: "page-one", exhausted: true })
                .mockResolvedValueOnce({ events: [], cursor: "page-two", exhausted: true }),
            backfillRoom: vi
                .fn()
                .mockResolvedValue({ exhausted: true, scanned: 0, indexed: 0, canContinue: false, reason: "end" }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "media", "");
        vm.loadMoreLocal();
        vm.loadMoreLocal();
        expect(index.queryFileEvents).toHaveBeenCalledOnce();
        expect(index.backfillRoom).not.toHaveBeenCalled();
        await vm.loadMore();
        expect(index.backfillRoom).toHaveBeenCalledOnce();
        expect(index.queryFileEvents).toHaveBeenCalledTimes(2);
        vm.dispose();
    });

    it("resumes a stopped foreground search across history batches", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], cursor: "end", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: true, scanned: 0, indexed: 0, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "");
        vm.stop();
        vm.resume();
        await vi.waitFor(() => expect(vm.getSnapshot().loading).toBe(false));
        expect(index.backfillRoom).toHaveBeenCalled();
        vm.dispose();
    });

    it("drops an in-flight page immediately when a sender draft changes", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const oldPage = Promise.withResolvers<{ events: MatrixEvent[]; cursor: string; exhausted: boolean }>();
        const index = {
            queryFileEvents: vi.fn().mockReturnValueOnce(oldPage.promise).mockResolvedValue({
                events: [],
                cursor: "end",
                exhausted: true,
            }),
            backfillRoom: vi.fn(),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const initial = vm.reset(room.roomId, "files", "");
        await vi.waitFor(() => expect(index.queryFileEvents).toHaveBeenCalledOnce());
        vm.setFilters({ sender: "@bob:id" });
        oldPage.resolve({ events: [makeFile("$old", "old.pdf")], cursor: "old", exhausted: true });
        await initial;
        expect(vm.getSnapshot().events).toEqual([]);
        expect(vm.getSnapshot().draftPending).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(index.queryFileEvents).toHaveBeenCalledTimes(2);
        expect(index.backfillRoom).toHaveBeenCalled();
        vm.dispose();
    });

    it("debounces sender changes and starts a new foreground search", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], cursor: "end", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: true, scanned: 0, indexed: 0, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "");
        expect(index.backfillRoom).toHaveBeenCalledOnce();
        vm.setFilters({ sender: "@a" });
        vm.setFilters({ sender: "@alice:id" });
        expect(vm.getSnapshot().draftPending).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(index.queryFileEvents).toHaveBeenCalledTimes(4);
        expect(index.queryFileEvents).toHaveBeenLastCalledWith(room, expect.objectContaining({ sender: "@alice:id" }));
        expect(index.backfillRoom).toHaveBeenCalledTimes(2);
        vm.dispose();
    });

    it.each(["files", "media"] as const)("finds sparse %s on open without five clicks", async (category) => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const found = makeFile("$found", "found.png", category === "media" ? "m.image" : "m.file");
        let query = 0;
        const index = {
            queryFileEvents: vi.fn().mockImplementation(async () => ({
                events: ++query === 6 ? [found] : [],
                cursor: `cursor-${query}`,
                exhausted: true,
            })),
            backfillRoom: vi.fn().mockImplementation(async () => ({
                scanned: 500,
                indexed: 1,
                exhausted: query >= 5,
                canContinue: query < 5,
            })),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, category, "");
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$found"]);
        expect(vm.getSnapshot().scanned).toBe(2500);
        expect(index.backfillRoom).toHaveBeenCalledTimes(5);
        vm.dispose();
    });

    it("shows a current-timeline attachment while older history is still loading", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const history = Promise.withResolvers<{
            scanned: number;
            indexed: number;
            exhausted: boolean;
            canContinue: boolean;
        }>();
        let timelineReady = false;
        const index = {
            ensureRoomTimelineIndexed: vi.fn().mockImplementation(async () => {
                timelineReady = true;
            }),
            queryFileEvents: vi.fn().mockImplementation(async () => ({
                events: timelineReady ? [makeFile("$visible", "visible.pdf")] : [],
                cursor: "oldest",
                exhausted: true,
            })),
            backfillRoom: vi.fn().mockReturnValue(history.promise),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const opening = vm.reset(room.roomId, "files", "");
        await vi.waitFor(() => expect(index.backfillRoom).toHaveBeenCalledOnce());
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$visible"]);
        history.resolve({ scanned: 50, indexed: 0, exhausted: true, canContinue: false });
        await opening;
        vm.dispose();
    });

    it("ends the foreground spinner at the soft budget without claiming history is complete", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(9001);
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], cursor: "earlier", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 500, indexed: 0, exhausted: false, canContinue: true }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "");
        expect(vm.getSnapshot()).toMatchObject({ loading: false, exhausted: false, scanned: 500 });
        expect(index.backfillRoom).toHaveBeenCalledOnce();
        now.mockRestore();
        vm.dispose();
    });

    it("publishes the first attachment before a later local page settles and stops cleanly", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; cursor: string; exhausted: boolean }>();
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [makeFile("$first", "first.pdf")], cursor: "next", exhausted: false })
                .mockReturnValueOnce(pending.promise),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const opening = vm.reset(room.roomId, "files", "");
        await vi.waitFor(() => expect(index.queryFileEvents).toHaveBeenCalledTimes(2));
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$first"]);
        expect(vm.getSnapshot().loading).toBe(true);
        vm.stop();
        expect(vm.getSnapshot().loading).toBe(false);
        pending.resolve({ events: [makeFile("$late", "late.pdf")], cursor: "last", exhausted: true });
        await opening;
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$first"]);
        vm.dispose();
    });

    it("keeps live invalidations authoritative across pending pages and inactive tabs", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const old = makeFile("$old", "report.pdf");
        const next = Promise.withResolvers<{ events: MatrixEvent[]; cursor: string; exhausted: boolean }>();
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [old], cursor: "first", exhausted: false })
                .mockReturnValueOnce(next.promise)
                .mockResolvedValue({ events: [], cursor: "end", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        const opening = vm.reset(room.roomId, "files", "report");
        await vi.waitFor(() => expect(index.queryFileEvents).toHaveBeenCalledTimes(2));
        vm.redactEvent("$old");
        next.resolve({ events: [old, makeFile("$new", "report-new.pdf")], cursor: "end", exhausted: true });
        await opening;
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$new"]);
        await vm.reset(room.roomId, "media", "report");
        vm.addLiveEvent(makeFile("$image", "report.png", "m.image"));
        vm.redactEvent("$new");
        const edit = new MatrixEvent({ ...old.event, event_id: "$edit", origin_server_ts: 20 });
        vm.replaceEvent("$old", { msgtype: "m.file", filename: "report-restored.pdf" }, edit);
        await vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot().events).toEqual([]);
        vm.dispose();
    });

    it("rechecks a cached indexed match that disappears from the index before showing the tab", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const indexed = makeFile("$old", "report.pdf");
        const index = {
            queryFileEvents: vi.fn().mockImplementation((_: Room, query: { category: string }) =>
                Promise.resolve({
                    events: query.category === "files" ? [indexed] : [],
                    exhausted: true,
                }),
            ),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot().events).toHaveLength(1);
        await vm.reset(room.roomId, "media", "report");
        // Simulate the Worker withdrawing the edit without a timeline event reaching this panel.
        vi.mocked(index.queryFileEvents).mockResolvedValue({ events: [], exhausted: true });
        const returning = vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot().events).toEqual([]);
        await returning;
        expect(vm.getSnapshot().events).toEqual([]);
        vm.dispose();
    });

    it.each(["failure", "timeout"] as const)(
        "retains a committed indexed match if tab refresh ends in %s",
        async (outcome) => {
            mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
            vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
            vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
            const pending = Promise.withResolvers<{ events: MatrixEvent[]; exhausted: boolean }>();
            let fileReads = 0;
            const index = {
                queryFileEvents: vi.fn().mockImplementation((_: Room, query: { category: string }) => {
                    if (query.category === "media") return Promise.resolve({ events: [], exhausted: true });
                    fileReads++;
                    if (fileReads === 1)
                        return Promise.resolve({ events: [makeFile("$file", "report.pdf")], exhausted: true });
                    if (fileReads === 2) return Promise.resolve({ events: [], exhausted: true });
                    return outcome === "failure" ? Promise.reject(new Error("index unavailable")) : pending.promise;
                }),
                backfillRoom: vi
                    .fn()
                    .mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
            } as unknown as EventIndex;
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
            const vm = new RoomFileSearchViewModel();
            await vm.reset(room.roomId, "files", "report");
            expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$file"]);
            await vm.reset(room.roomId, "media", "report");
            if (outcome === "timeout") vi.useFakeTimers();
            try {
                const returning = vm.reset(room.roomId, "files", "report");
                expect(vm.getSnapshot().events).toEqual([]);
                if (outcome === "timeout") {
                    await vi.advanceTimersByTimeAsync(8_001);
                    expect(vm.getSnapshot()).toMatchObject({ loading: false, stopped: true });
                }
                await returning;
                expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$file"]);
                expect(vm.getSnapshot()).toMatchObject({ loading: false, error: expect.any(Error) });
                vm.dispose();
                pending.resolve({ events: [], exhausted: true });
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it("keeps an indexed result visible when returning to an explicitly stopped tab", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const index = {
            queryFileEvents: vi.fn().mockImplementation((_: Room, query: { category: string }) =>
                Promise.resolve({
                    events: query.category === "files" ? [makeFile("$file", "report.pdf")] : [],
                    exhausted: true,
                }),
            ),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "report");
        vm.stop();
        await vm.reset(room.roomId, "media", "report");
        await vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot()).toMatchObject({ stopped: true, loading: false });
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$file"]);
        vm.dispose();
    });

    it("preserves live-only edits across a cached tab while the index is behind", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "report");
        const original = makeFile("$file", "other.pdf");
        vm.addLiveEvent(original);
        vm.replaceEvent(
            "$file",
            { msgtype: "m.file", filename: "report-live.pdf" },
            new MatrixEvent({ ...original.event, event_id: "$live", origin_server_ts: 30 }),
        );
        expect(vm.getSnapshot().events.map((event) => event.getContent().filename)).toEqual(["report-live.pdf"]);
        await vm.reset(room.roomId, "media", "report");
        await vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot().events.map((event) => event.getContent().filename)).toEqual(["report-live.pdf"]);
        vm.dispose();
    });

    it("reprojects an inactive tab when its latest edit is withdrawn", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "report");
        const original = makeFile("$file", "report.pdf");
        vm.addLiveEvent(original);
        await vm.reset(room.roomId, "media", "report");
        const edit = new MatrixEvent({ ...original.event, event_id: "$edit", origin_server_ts: 30 });
        vm.replaceEvent("$file", { msgtype: "m.file", filename: "other.pdf" }, edit);
        await vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot().events).toEqual([]);
        await vm.reset(room.roomId, "media", "report");
        vm.redactEvent("$edit");
        await vm.reset(room.roomId, "files", "report");
        expect(vm.getSnapshot().events.map((event) => event.getId())).toEqual(["$file"]);
        vm.dispose();
    });

    it("should project live additions, edits and redactions through the current file query", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => false }) as never });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        const index = {
            loadFileEvents: vi.fn().mockResolvedValue([]),
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: true, scanned: 0, indexed: 0, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const vm = new RoomFileSearchViewModel();
        await vm.reset(room.roomId, "files", "report");
        const file = makeFile("$file", "report.pdf");
        vm.addLiveEvent(file);
        vm.addLiveEvent(file);
        expect(vm.getSnapshot().events).toHaveLength(1);
        vm.replaceEvent(
            "$file",
            { msgtype: "m.file", filename: "other.pdf", body: "other.pdf" },
            new MatrixEvent({ ...file.event, event_id: "$edit" }),
        );
        expect(vm.getSnapshot().events).toEqual([]);
        vm.addLiveEvent(file);
        vm.redactEvent("$file");
        expect(vm.getSnapshot().events).toEqual([]);
        vm.dispose();
    });
});
