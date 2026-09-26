/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventTimeline, MatrixEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { mkEncryptedMatrixEvent } from "matrix-js-sdk/src/testing";
import encrypt from "matrix-encrypt-attachment";
import { mockPlatformPeg } from "test-utils";

import { RoomFileSearchSession } from "./RoomFileSearchSession";
import { rememberOriginalFileEvent } from "./RoomFileSearchOriginals";
import { WebEventIndexError } from "../indexing/web/WebEventIndexError";
import EventIndexPeg from "../indexing/EventIndexPeg";
import { MatrixClientPeg } from "../MatrixClientPeg";
import type EventIndex from "../indexing/EventIndex";
import { MediaEventHelper } from "../utils/MediaEventHelper";

const file = new MatrixEvent({
    event_id: "$old",
    room_id: "!room:id",
    type: "m.room.message",
    sender: "@a:id",
    origin_server_ts: 1,
    content: { msgtype: "m.file", body: "description", filename: "old.pdf" },
});
const room = { roomId: "!room:id" } as Room;
const client = {
    getRoom: () => room,
    mxcUrlToHttp: () => "https://example.org/media",
} as unknown as MatrixClient;

async function makeEncryptedFile(
    eventId: string,
    filename: string,
    timestamp: number,
    file: Record<string, unknown> = {
        url: `mxc://example.org/${eventId.slice(1)}`,
        key: {
            kty: "oct",
            key_ops: ["encrypt", "decrypt"],
            alg: "A256CTR",
            k: "fixture-key",
            ext: true,
        },
        iv: "fixture-iv",
        hashes: { sha256: "fixture-hash" },
    },
): Promise<MatrixEvent> {
    const event = await mkEncryptedMatrixEvent({
        roomId: room.roomId,
        sender: "@a:id",
        plainType: "m.room.message",
        plainContent: {
            msgtype: "m.file",
            body: filename,
            filename,
            file,
            info: { mimetype: "application/pdf" },
        },
        eventId,
    });
    event.event.origin_server_ts = timestamp;
    return event;
}

beforeEach(() => {
    vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
    vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("RoomFileSearchSession", () => {
    it("should not let a stopped backfill start an old scan after resume, and should rescan without duplicates", async () => {
        const backfill = Promise.withResolvers<{
            exhausted: boolean;
            scanned: number;
            indexed: number;
            canContinue: boolean;
        }>();
        const newer = new MatrixEvent({ ...file.event, event_id: "$new", origin_server_ts: 2 });
        const others = Array.from({ length: 49 }, (_, i) => new MatrixEvent({ ...file.event, event_id: `$extra${i}` }));
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [file], cursor: "old-cursor", exhausted: true })
                .mockResolvedValueOnce({
                    events: [newer, file, ...others.slice(0, 48)],
                    cursor: "new-cursor",
                    exhausted: false,
                })
                .mockResolvedValueOnce({ events: [others[48]], cursor: "end", exhausted: false }),
            backfillRoom: vi.fn().mockReturnValue(backfill.promise),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);
        const initial = session.loadMore();
        await vi.waitFor(() => expect(index.backfillRoom).toHaveBeenCalledOnce());
        session.stop();
        expect(session.resume()).toBe(false);
        expect(index.queryFileEvents).toHaveBeenCalledOnce();
        backfill.resolve({ exhausted: false, scanned: 1, indexed: 1, canContinue: true });
        expect((await initial).events).toEqual([]);
        expect(session.resume()).toBe(true);
        const page = await session.loadMore();
        expect(page.events.map((event) => event.getId()).filter((id) => id === "$old")).toEqual(["$old"]);
        expect(page.events.map((event) => event.getId())).toContain("$new");
        expect(index.queryFileEvents).toHaveBeenCalledTimes(2);
        expect(index.queryFileEvents).toHaveBeenNthCalledWith(2, room, {
            category: "files",
            term: "",
            limit: 50,
            cursor: undefined,
        });
        expect(index.backfillRoom).toHaveBeenCalledOnce();
    });

    it.each([
        { label: "end", reason: "end", canContinue: false, accessLimited: false, retry: false },
        { label: "forbidden", reason: "forbidden", canContinue: false, accessLimited: true, retry: false },
        { label: "retryable error", reason: undefined, canContinue: true, accessLimited: false, retry: true },
    ])(
        "should retain a stopped backfill's $label continuation without starting another history batch",
        async (caseData) => {
            const pending = Promise.withResolvers<{
                exhausted: boolean;
                scanned: number;
                indexed: number;
                canContinue: boolean;
                reason?: string;
                error?: WebEventIndexError;
            }>();
            const index = {
                queryFileEvents: vi
                    .fn()
                    .mockResolvedValueOnce({ events: [], cursor: "old-cursor", exhausted: true })
                    .mockResolvedValueOnce({ events: [file], cursor: "last", exhausted: true }),
                backfillRoom: vi.fn().mockReturnValue(pending.promise),
            } as unknown as EventIndex;
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
            const session = new RoomFileSearchSession(client, room, index, "files", "", true);
            const first = session.loadMore();
            await vi.waitFor(() => expect(index.backfillRoom).toHaveBeenCalledOnce());
            session.stop();
            expect(session.resume()).toBe(false);
            pending.resolve({
                exhausted: !caseData.canContinue,
                scanned: 1,
                indexed: 1,
                canContinue: caseData.canContinue,
                reason: caseData.reason,
                error: caseData.retry
                    ? new WebEventIndexError({ code: "network_failure", operation: "backfill", retryability: "retry" })
                    : undefined,
            });
            expect((await first).events).toEqual([]);
            expect(session.resume()).toBe(true);
            const page = await session.loadMore();
            expect(page.events.map((event) => event.getId())).toEqual(["$old"]);
            expect(page.accessLimited).toBe(caseData.accessLimited);
            expect(page.error?.code).toBe(caseData.retry ? "network_failure" : undefined);
            expect(session.retryHistory()).toBe(caseData.retry);
            expect(index.backfillRoom).toHaveBeenCalledOnce();
            expect(index.queryFileEvents).toHaveBeenNthCalledWith(2, room, {
                category: "files",
                term: "",
                limit: 50,
                cursor: undefined,
            });
        },
    );

    it("should consume the last backfill batch, even when it reports exhausted", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [], cursor: "older", exhausted: true })
                .mockResolvedValueOnce({ events: [file], cursor: "oldest", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 1, indexed: 1, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "old.pdf", true);
        expect((await session.loadMore()).events.map((ev) => ev.getId())).toEqual(["$old"]);
        expect(index.queryFileEvents).toHaveBeenLastCalledWith(room, {
            category: "files",
            term: "old.pdf",
            limit: 50,
            cursor: "older",
        });
        expect(session.hasMore).toBe(false);
    });

    it("should keep searching after the first empty gap when a later gap has an attachment", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [], cursor: "first", exhausted: true })
                .mockResolvedValueOnce({ events: [], cursor: "second", exhausted: true })
                .mockResolvedValueOnce({ events: [file], cursor: "third", exhausted: true }),
            backfillRoom: vi
                .fn()
                .mockResolvedValueOnce({ exhausted: false, scanned: 1, indexed: 0, canContinue: true })
                .mockResolvedValueOnce({ exhausted: true, scanned: 1, indexed: 1, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "old.pdf", true);
        expect((await session.loadMore()).events).toEqual([]);
        expect(session.hasMore).toBe(true);
        expect((await session.loadMore()).events.map((ev) => ev.getId())).toEqual(["$old"]);
        expect(index.backfillRoom).toHaveBeenNthCalledWith(2, room.roomId, 500);
        expect(index.backfillRoom).toHaveBeenCalledTimes(2);
    });

    it("should advance shared room history at most once per explicit load with no matching files", async () => {
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [], cursor: "first", exhausted: true })
                .mockResolvedValueOnce({ events: [], cursor: "second", exhausted: true })
                .mockResolvedValueOnce({ events: [], cursor: "third", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({
                exhausted: false,
                scanned: 0,
                indexed: 0,
                canContinue: false,
                reason: "stalled",
                error: new Error("History pagination cursor unavailable"),
            }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "no-match", true);

        const first = await session.loadMore();
        expect(first.events).toEqual([]);
        expect(first.cursorFailed).toBe(true);
        expect(first.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledTimes(1);
        expect(index.queryFileEvents).toHaveBeenNthCalledWith(2, room, {
            category: "files",
            term: "no-match",
            limit: 50,
            cursor: "first",
        });

        expect(session.retryHistory()).toBe(false);
        await session.loadMore();
        expect(index.backfillRoom).toHaveBeenCalledTimes(1);
        expect(index.queryFileEvents).toHaveBeenCalledTimes(2);
    });

    it("should retry a network backfill failure only after an explicit retry", async () => {
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], cursor: "current", exhausted: true }),
            backfillRoom: vi
                .fn()
                .mockResolvedValueOnce({
                    exhausted: false,
                    scanned: 0,
                    indexed: 0,
                    canContinue: true,
                    error: new WebEventIndexError({
                        code: "network_failure",
                        operation: "backfill",
                        retryability: "retry",
                    }),
                })
                .mockResolvedValueOnce({ exhausted: true, scanned: 0, indexed: 0, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);

        const failed = await session.loadMore();
        expect(failed.error?.code).toBe("network_failure");
        expect(failed.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledOnce();

        expect(session.retryHistory()).toBe(true);
        const retried = await session.loadMore();
        expect(retried.error).toBeUndefined();
        expect(retried.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledTimes(2);
    });

    it("should not authorize a history retry when a backfill RPC rejects without an outcome", async () => {
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], cursor: "oldest", exhausted: true }),
            backfillRoom: vi.fn().mockRejectedValue(
                new WebEventIndexError({
                    code: "network_failure",
                    operation: "backfill",
                    retryability: "retry",
                }),
            ),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);

        const failed = await session.loadMore();
        expect(failed.error?.code).toBe("network_failure");
        expect(failed.hasMore).toBe(false);
        expect(session.retryHistory()).toBe(false);
        await session.loadMore();
        expect(index.backfillRoom).toHaveBeenCalledOnce();
    });

    it("should reach an explicit retry after a terminal-looking local page and retryable backfill error", async () => {
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], cursor: "oldest", exhausted: true }),
            backfillRoom: vi
                .fn()
                .mockResolvedValueOnce({
                    exhausted: false,
                    scanned: 0,
                    indexed: 0,
                    canContinue: false,
                    error: new WebEventIndexError({
                        code: "network_failure",
                        operation: "backfill",
                        retryability: "retry",
                    }),
                })
                .mockResolvedValueOnce({ exhausted: true, scanned: 1, indexed: 1, canContinue: false, reason: "end" }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);

        const failed = await session.loadMore();
        expect(failed.hasMore).toBe(false);
        expect(failed.error?.code).toBe("network_failure");
        expect(session.retryHistory()).toBe(true);
        expect(session.hasMore).toBe(true);

        const retried = await session.loadMore();
        expect(retried.error).toBeUndefined();
        expect(retried.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledTimes(2);
    });

    it("should retry a provider query without changing the EventIndex continuation", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        const nextPage = Array.from(
            { length: 50 },
            (_, i) =>
                new MatrixEvent({
                    ...file.event,
                    event_id: `$match${i}`,
                    content: { msgtype: "m.file", body: "match", filename: `match-${i}.pdf` },
                }),
        );
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [], cursor: "initial", exhausted: true })
                .mockRejectedValueOnce(
                    new WebEventIndexError({
                        code: "storage_error",
                        operation: "queryFileEvents",
                        retryability: "user_action",
                    }),
                )
                .mockResolvedValueOnce({ events: nextPage, cursor: "next", exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({
                exhausted: false,
                scanned: 1,
                indexed: 1,
                canContinue: true,
            }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "match", true);

        const failed = await session.loadMore();
        expect(failed.error).toMatchObject({ operation: "queryFileEvents", code: "storage_error" });
        expect(failed.hasMore).toBe(true);
        expect(session.retryHistory()).toBe(false);

        const retried = await session.loadMore();
        expect(retried.events).toHaveLength(50);
        expect(index.backfillRoom).toHaveBeenCalledOnce();
        expect(index.queryFileEvents).toHaveBeenCalledTimes(3);
    });

    it.each(["missing_token", "stalled"])(
        "should show the final attachment batch and pause automatic history after %s",
        async (reason) => {
            mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
            const index = {
                queryFileEvents: vi
                    .fn()
                    .mockResolvedValueOnce({ events: [], cursor: "older", exhausted: true })
                    .mockResolvedValueOnce({ events: [file], cursor: "last", exhausted: true }),
                backfillRoom: vi.fn().mockResolvedValue({
                    exhausted: false,
                    scanned: 1,
                    indexed: 1,
                    canContinue: false,
                    reason,
                    error: new Error("History pagination cursor unavailable"),
                }),
            } as unknown as EventIndex;
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
            const session = new RoomFileSearchSession(client, room, index, "files", "old.pdf", true);
            const page = await session.loadMore();
            expect(page.events.map((ev) => ev.getId())).toEqual(["$old"]);
            expect(page.cursorFailed).toBe(true);
            expect(session.hasMore).toBe(false);
            expect(session.retryHistory()).toBe(false);
            await session.loadMore();
            expect(index.backfillRoom).toHaveBeenCalledOnce();
        },
    );

    it("should distinguish an inaccessible older range from complete file history", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [], exhausted: true }),
            backfillRoom: vi.fn().mockResolvedValue({
                exhausted: false,
                scanned: 0,
                indexed: 0,
                canContinue: false,
                reason: "forbidden",
            }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);
        const page = await session.loadMore();
        expect(page.accessLimited).toBe(true);
        expect(page.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledTimes(1);
    });

    it("should scan desktop legacy pages beyond the visible UI list, without invoking unsupported query", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => false }) as never });
        const unrelated = new MatrixEvent({
            event_id: "$unrelated",
            room_id: room.roomId,
            type: "m.room.message",
            origin_server_ts: 10,
            content: { msgtype: "m.image", body: "other" },
        });
        const firstPage = Array.from(
            { length: 50 },
            (_, i) =>
                new MatrixEvent({
                    ...unrelated.event,
                    event_id: `$file${i}`,
                    content: { msgtype: "m.file", body: "other" },
                }),
        );
        const index = {
            queryFileEvents: vi.fn(),
            loadFileEvents: vi
                .fn()
                .mockResolvedValueOnce(firstPage)
                .mockResolvedValueOnce([file])
                .mockResolvedValue([]),
            backfillRoom: vi.fn().mockResolvedValue({ scanned: 0, indexed: 0, exhausted: true, canContinue: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "old.pdf", false);
        const result = await session.loadMore();
        expect(result.events.map((event) => event.getId())).toEqual(["$old"]);
        expect(index.loadFileEvents).toHaveBeenNthCalledWith(2, room, 50, "$file49", EventTimeline.BACKWARDS);
        expect(index.queryFileEvents).not.toHaveBeenCalled();
        expect(session.isIndexedQuery).toBe(false);
    });

    it("should keep a pending edit instead of restoring the old page content", async () => {
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; cursor: string; exhausted: boolean }>();
        const index = { queryFileEvents: vi.fn().mockReturnValue(pending.promise) } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "new", true);
        const loading = session.loadMore(false);
        const edit = new MatrixEvent({ ...file.event, event_id: "$edit" });
        session.edit("$old", { msgtype: "m.file", body: "new.pdf", filename: "new.pdf" }, edit);
        pending.resolve({ events: [file], cursor: "end", exhausted: true });
        const page = await loading;
        expect(page.events.map((ev) => ev.getContent().filename)).toEqual(["new.pdf"]);
        session.redact("$old");
        expect(session.current).toEqual([]);
        session.dispose();
    });

    it("should not resurrect a pending edit after redaction and a late page", async () => {
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; cursor: string; exhausted: boolean }>();
        const newer = new MatrixEvent({ ...file.event, event_id: "$new" });
        const index = { queryFileEvents: vi.fn().mockReturnValue(pending.promise) } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);
        const loading = session.loadMore(false);
        const edit = new MatrixEvent({ ...file.event, event_id: "$edit" });
        session.edit("$old", { msgtype: "m.file", body: "edited", filename: "edited.pdf" }, edit);
        session.redact("$old");
        pending.resolve({ events: [file, newer], cursor: "end", exhausted: true });
        expect((await loading).events.map((event) => event.getId())).toEqual(["$new"]);
        session.add(file);
        expect(session.current.map((event) => event.getId())).toEqual(["$new"]);
    });

    it("should not let duplicate live events overwrite an edit, including a pending edit", async () => {
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [file], exhausted: true }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "", true);
        const edit = new MatrixEvent({ ...file.event, event_id: "$edit" });
        session.edit("$old", { msgtype: "m.file", body: "edited", filename: "edited.pdf" }, edit);
        session.add(file);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["edited.pdf"]);
        await session.loadMore(false);
        session.add(file);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["edited.pdf"]);
    });

    it("preserves the decrypted type while projecting encrypted live edits and redactions", async () => {
        const index = { queryFileEvents: vi.fn() } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const encryptedPayload = await encrypt.encryptAttachment(
            new TextEncoder().encode("downloaded attachment").buffer,
        );
        const downloadableFile = { ...encryptedPayload.info, url: "mxc://example.org/download" };
        const original = await makeEncryptedFile("$encrypted", "report.pdf", 10, downloadableFile);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        session.add(original);
        expect(session.current).toHaveLength(1);
        expect(session.current[0].getType()).toBe("m.room.message");
        expect(session.current[0].getContent().filename).toBe("report.pdf");

        const edit = async (id: string, timestamp: number, filename: string): Promise<void> => {
            session.edit(
                "$encrypted",
                { msgtype: "m.file", body: filename, filename },
                await makeEncryptedFile(id, filename, timestamp, downloadableFile),
            );
        };
        await edit("$e2", 30, "report-new.pdf");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-new.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");
        expect(session.current[0].getContent()).toMatchObject({ file: downloadableFile });

        // Exercise the same authenticated/decrypting path used by the media tile, not just the projection fields.
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => encryptedPayload.data,
        });
        vi.stubGlobal("fetch", fetchMock);
        const helper = new MediaEventHelper(session.current[0]);
        const blob = await helper.sourceBlob.value;
        expect(await blob.text()).toBe("downloaded attachment");
        expect(fetchMock).toHaveBeenCalledWith("https://example.org/media");
        helper.destroy();

        // A late older edit must not replace the newer encrypted edit.
        await edit("$e1", 20, "old.pdf");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-new.pdf"]);

        await edit("$e3", 40, "other.pdf");
        expect(session.current).toEqual([]);
        session.redact("$e3");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-new.pdf"]);
        session.redact("$e2");
        expect(session.current).toEqual([]);
        session.redact("$e1");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");

        session.redact("$encrypted");
        await edit("$e4", 50, "report-again.pdf");
        expect(session.current).toEqual([]);
    });

    it("preserves an encrypted indexed projection when a cached refresh fails", async () => {
        // EventIndex maps the raw indexed original to the clear type before storing it in the session WeakMap.
        const rawOriginal = await makeEncryptedFile("$encrypted", "report.pdf", 10);
        const original = new MatrixEvent({
            ...rawOriginal.event,
            type: "m.room.message",
            content: rawOriginal.getContent(),
        });
        const indexed = async (revisionId: string, filename: string, timestamp: number): Promise<MatrixEvent> => {
            const event = await makeEncryptedFile("$encrypted", filename, 10);
            rememberOriginalFileEvent(event, original, [
                {
                    event_id: revisionId,
                    room_id: room.roomId,
                    sender: "@a:id",
                    timestamp,
                    content: {
                        msgtype: "m.file",
                        body: filename,
                        filename,
                        file: event.getContent().file,
                        info: event.getContent().info,
                    },
                },
            ]);
            return event;
        };
        const first = await indexed("$e2", "report-v2.pdf", 30);
        const refresh = await indexed("$e1", "report-v1.pdf", 20);
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [first], cursor: "initial", exhausted: true })
                .mockResolvedValueOnce({ events: [refresh], cursor: "refresh", exhausted: false })
                .mockRejectedValueOnce(new Error("refresh page failed")),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        await session.loadMore(false);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-v2.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");

        session.refreshIndexedResults();
        expect(session.resume()).toBe(true);
        const published: string[][] = [];
        const page = await session.searchUntilTarget(true, (nextPage) =>
            published.push(nextPage.events.map((event) => event.getContent().filename)),
        );

        expect(page.error).toBeDefined();
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-v2.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");
        expect(published).not.toContainEqual(["report-v1.pdf"]);
    });

    it("keeps an encrypted indexed original through edit redaction and a committed refresh", async () => {
        const rawOriginal = await makeEncryptedFile("$encrypted", "report.pdf", 10);
        const original = new MatrixEvent({
            ...rawOriginal.event,
            type: "m.room.message",
            content: rawOriginal.getContent(),
        });
        const indexed = async (revisionId: string, filename: string, timestamp: number): Promise<MatrixEvent> => {
            const event = await makeEncryptedFile("$encrypted", filename, 10);
            rememberOriginalFileEvent(event, original, [
                {
                    event_id: revisionId,
                    room_id: room.roomId,
                    sender: "@a:id",
                    timestamp,
                    content: {
                        msgtype: "m.file",
                        body: filename,
                        filename,
                    },
                },
            ]);
            return event;
        };
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [await indexed("$e2", "report-v2.pdf", 30)], exhausted: true })
                .mockResolvedValueOnce({ events: [await indexed("$e1", "report-v1.pdf", 20)], exhausted: true }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);

        await session.loadMore(false);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-v2.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");
        expect(session.current[0].getContent().file).toBeDefined();

        session.redact("$e2");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");

        session.refreshIndexedResults();
        expect(session.resume()).toBe(true);
        await session.loadMore(false);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-v1.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");
        expect(session.current[0].getContent().file).toBeDefined();

        session.redact("$e1");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report.pdf"]);
        expect(session.current[0].getType()).toBe("m.room.message");
    });

    it("reprojects the newest valid edit, including a return to the query and edit redactions", async () => {
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [file], exhausted: true }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        session.add(new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: "report.pdf" } }));
        const edit = (id: string, ts: number): MatrixEvent =>
            new MatrixEvent({ ...file.event, event_id: id, origin_server_ts: ts });
        const change = (id: string, ts: number, name: string): void => {
            session.edit("$old", { msgtype: "m.file", filename: name, body: name }, edit(id, ts));
        };
        change("$e1", 20, "other.pdf");
        expect(session.current).toEqual([]);
        change("$e2", 30, "report-v2.pdf");
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report-v2.pdf"]);
        change("$e0", 10, "older.pdf");
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report-v2.pdf"]);
        session.redact("$e2");
        expect(session.current).toEqual([]);
        session.redact("$e1");
        expect(session.current).toEqual([]);
        session.redact("$e0");
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report.pdf"]);
        session.redact("$old");
        change("$e3", 40, "report-again.pdf");
        expect(session.current).toEqual([]);
    });

    it("keeps the latest edit when it arrives before a pending page and rejects a late old edit", async () => {
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; exhausted: boolean }>();
        const index = { queryFileEvents: vi.fn().mockReturnValue(pending.promise) } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        const loading = session.loadMore(false);
        const edit = (id: string, ts: number, name: string): void => {
            session.edit(
                "$old",
                { msgtype: "m.file", filename: name, body: name },
                new MatrixEvent({ ...file.event, event_id: id, origin_server_ts: ts }),
            );
        };
        edit("$e2", 30, "report-new.pdf");
        edit("$e1", 20, "report-old.pdf");
        pending.resolve({ events: [file], exhausted: true });
        expect((await loading).events.map((ev) => ev.getContent().filename)).toEqual(["report-new.pdf"]);
        session.redact("$e2");
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report-old.pdf"]);
    });

    it("uses the original and revisions supplied with an indexed projection", async () => {
        const original = new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: "other.pdf" } });
        const projected = new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: "report.pdf" } });
        rememberOriginalFileEvent(projected, original, [
            {
                event_id: "$edit-indexed",
                room_id: room.roomId,
                sender: "@a:id",
                timestamp: 30,
                content: { msgtype: "m.file", filename: "report.pdf" },
            },
        ]);
        const index = {
            queryFileEvents: vi.fn().mockResolvedValue({ events: [projected], exhausted: true }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        expect((await session.loadMore(false)).events.map((event) => event.getContent().filename)).toEqual([
            "report.pdf",
        ]);
        session.redact("$edit-indexed");
        expect(session.current).toEqual([]);
        // A delayed indexed page must not restore the withdrawn revision.
        session.add(projected);
        expect(session.current).toEqual([]);
    });

    it("replaces indexed revisions but retains live revisions and tombstones on refresh", async () => {
        const index = { queryFileEvents: vi.fn() } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        const original = new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: "other.pdf" } });
        const projected = new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: "report-e2.pdf" } });
        rememberOriginalFileEvent(projected, original, [
            {
                event_id: "$e2",
                room_id: room.roomId,
                sender: "@a:id",
                timestamp: 20,
                content: { msgtype: "m.file", filename: "report-e2.pdf" },
            },
        ]);
        vi.mocked(index.queryFileEvents).mockResolvedValue({ events: [projected], exhausted: true });
        await session.loadMore(false);
        const live = new MatrixEvent({ ...file.event, event_id: "$live", origin_server_ts: 30 });
        session.edit("$old", { msgtype: "m.file", filename: "report-live.pdf" }, live);
        session.refreshIndexedResults();
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report-live.pdf"]);
        session.resume();
        await session.loadMore(false);
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report-live.pdf"]);
        session.redact("$e2");
        session.refreshIndexedResults();
        expect(session.current.map((ev) => ev.getContent().filename)).toEqual(["report-live.pdf"]);
    });

    it("keeps the committed revision when a later page of an indexed refresh fails", async () => {
        const original = new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: "other.pdf" } });
        const projected = (id: string, name: string, timestamp: number): MatrixEvent => {
            const event = new MatrixEvent({ ...file.event, content: { msgtype: "m.file", filename: name } });
            rememberOriginalFileEvent(event, original, [
                {
                    event_id: id,
                    room_id: room.roomId,
                    sender: "@a:id",
                    timestamp,
                    content: { msgtype: "m.file", filename: name },
                },
            ]);
            return event;
        };
        const first = projected("$e2", "report-v2.pdf", 30);
        const second = projected("$e1", "report-v1.pdf", 20);
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [first], exhausted: true })
                .mockResolvedValueOnce({ events: [second], exhausted: false })
                .mockRejectedValueOnce(new Error("next page failed")),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "report", true);
        await session.loadMore(false);
        session.refreshIndexedResults();
        session.resume();
        const published: string[][] = [];
        const page = await session.searchUntilTarget(true, (result) =>
            published.push(result.events.map((event) => event.getContent().filename)),
        );
        expect(page.error).toBeDefined();
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-v2.pdf"]);
        expect(published.at(-1)).toEqual(["report-v2.pdf"]);
        expect(published).not.toContainEqual(["report-v1.pdf"]);
    });

    it("restores committed indexed matches when a cached re-scan runs out of budget", async () => {
        const index = {
            queryFileEvents: vi
                .fn()
                .mockResolvedValueOnce({ events: [file], exhausted: true })
                .mockResolvedValue({ events: [], exhausted: false }),
        } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "old", true);
        await session.loadMore(false);
        session.refreshIndexedResults();
        session.resume();
        const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(9_001);
        const published: string[][] = [];
        const page = await session.searchUntilTarget(true, (result) =>
            published.push(result.events.map((ev) => ev.getId()!)),
        );
        expect(index.queryFileEvents).toHaveBeenCalledTimes(4);
        expect(published[0]).toEqual([]);
        expect(published.at(-1)).toEqual(["$old"]);
        expect(page.events.map((event) => event.getId())).toEqual(["$old"]);
        expect(page.hasMore).toBe(true);
        now.mockRestore();
    });

    it("does not start another history request if the task budget expires during the yield", async () => {
        vi.useFakeTimers();
        try {
            vi.spyOn(performance, "now")
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(7_999)
                .mockReturnValue(8_001);
            const index = {
                queryFileEvents: vi.fn().mockResolvedValue({ events: [], exhausted: true }),
                backfillRoom: vi
                    .fn()
                    .mockResolvedValue({ scanned: 1, indexed: 0, exhausted: false, canContinue: true }),
            } as unknown as EventIndex;
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
            const session = new RoomFileSearchSession(client, room, index, "files", "", true);
            const search = session.searchUntilTarget();
            await vi.advanceTimersByTimeAsync(1);
            await vi.advanceTimersByTimeAsync(1);
            const page = await search;
            expect(page).toMatchObject({ hasMore: true, scanned: 1 });
            expect(index.backfillRoom).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should discard an old query after disposal", async () => {
        mockPlatformPeg({ getEventIndexingManager: () => ({ supportsFilteredFileQuery: () => true }) as never });
        const pending = Promise.withResolvers<{ events: MatrixEvent[]; exhausted: boolean }>();
        const index = { queryFileEvents: vi.fn().mockReturnValue(pending.promise) } as unknown as EventIndex;
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index);
        const session = new RoomFileSearchSession(client, room, index, "files", "old", true);
        const loading = session.loadMore();
        session.dispose();
        pending.resolve({ events: [file], exhausted: true });
        expect((await loading).events).toEqual([]);
    });
});
