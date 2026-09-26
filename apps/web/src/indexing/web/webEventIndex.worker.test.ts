/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { IEventWithRoomId } from "matrix-js-sdk/src/matrix";

import { WebEventIndexError } from "./WebEventIndexError";

interface Reply {
    id: number;
    reply?: unknown;
    error?: unknown;
}

const pending = new Map<number, (result: Reply) => void>();
let nextId = 0;
const worker = {
    postMessage: (result: Reply): void => pending.get(result.id)?.(result),
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
};

async function call<T>(name: string, ...args: unknown[]): Promise<T> {
    const id = ++nextId;
    const response = new Promise<Reply>((resolve) => pending.set(id, resolve));
    worker.onmessage!({ data: { id, name, args } } as MessageEvent);
    const result = await response;
    pending.delete(id);
    if (result.error !== undefined) {
        throw (
            WebEventIndexError.fromPayload(result.error) ??
            new WebEventIndexError({ code: "unknown", operation: "rpc", retryability: "never" })
        );
    }
    return result.reply as T;
}

function edit(id: string, targetId: string, ts: number, sender = "@a:id", roomId = "!room:id"): IEventWithRoomId {
    return {
        event_id: id,
        room_id: roomId,
        origin_server_ts: ts,
        sender,
        type: "m.room.message",
        content: {
            "m.relates_to": { rel_type: "m.replace", event_id: targetId },
            "m.new_content": { msgtype: "m.text", body: "new body" },
        },
    };
}

function message(id: string, ts: number, content: Record<string, unknown>): IEventWithRoomId {
    return {
        event_id: id,
        room_id: "!room:id",
        origin_server_ts: ts,
        sender: "@a:id",
        type: "m.room.message",
        content,
    };
}

beforeAll(async () => {
    vi.stubGlobal("self", worker);
    await import("./webEventIndex.worker");
});

beforeEach(async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    await call("initEventIndex", "@a:id", "device");
    await call("setMaxEventAgeDays", 0);
});

afterEach(async () => {
    await call("closeEventIndex");
    vi.restoreAllMocks();
    pending.clear();
});

describe("webEventIndex.worker with IndexedDB", () => {
    it("should filter attachments by category, filename and body across stable same-timestamp pages", async () => {
        await call(
            "addEventToIndex",
            message("$a", 10, { msgtype: "m.file", filename: "合同.pdf", body: "description", url: "mxc://a" }),
            {},
        );
        await call(
            "addEventToIndex",
            message("$b", 10, { msgtype: "m.file", filename: "other.pdf", body: "合同 notes", url: "mxc://b" }),
            {},
        );
        await call(
            "addEventToIndex",
            message("$c", 10, { msgtype: "m.image", filename: "合同.png", body: "photo", url: "mxc://c" }),
            {},
        );
        type Page = { events: Array<{ event: IEventWithRoomId }>; cursor?: string; exhausted: boolean };
        const query = { roomId: "!room:id", category: "files", term: "合同", limit: 1 };
        const first = await call<Page>("queryFileEvents", query);
        const second = await call<Page>("queryFileEvents", { ...query, cursor: first.cursor });
        const last = await call<Page>("queryFileEvents", { ...query, cursor: second.cursor });
        expect([first.events[0].event.event_id, second.events[0].event.event_id]).toEqual(["$b", "$a"]);
        expect(last.events).toEqual([]);
        expect(last.exhausted).toBe(true);
        const media = await call<Page>("queryFileEvents", { ...query, category: "media" });
        expect(media.events.map(({ event }) => event.event_id)).toEqual(["$c"]);
    });

    it("should use the type index to find a sparse attachment without scanning unrelated messages", async () => {
        const events = Array.from({ length: 2100 }, (_, i) => ({
            event: message(`$text${i}`, i + 2, { msgtype: "m.text", body: "ordinary" }),
            profile: {},
        }));
        await call("addHistoricEvents", events, null, null);
        await call(
            "addEventToIndex",
            message("$old-file", 1, { msgtype: "m.file", filename: "needle", body: "x" }),
            {},
        );
        type Page = { events: Array<{ event: IEventWithRoomId }>; cursor?: string; exhausted: boolean };
        const query = { roomId: "!room:id", category: "files", term: "needle", limit: 50 };
        const coldStart = performance.now();
        const first = await call<Page>("queryFileEvents", query);
        const coldMs = performance.now() - coldStart;
        const warmStart = performance.now();
        const repeated = await call<Page>("queryFileEvents", query);
        const warmMs = performance.now() - warmStart;
        const nextStart = performance.now();
        const second = await call<Page>("queryFileEvents", { ...query, cursor: first.cursor });
        const nextMs = performance.now() - nextStart;
        expect(repeated.cursor).toBe(first.cursor);
        expect(first.events.map(({ event }) => event.event_id)).toEqual(["$old-file"]);
        expect(first.exhausted).toBe(true);
        expect(second.events).toEqual([]);
        expect(second.exhausted).toBe(true);
        // Timing is diagnostic only: fake IndexedDB is not a browser/Worker performance benchmark.
        console.info(
            `fake-indexeddb 2101 records: cold ${coldMs.toFixed(1)}ms; warm ${warmMs.toFixed(1)}ms; next ${nextMs.toFixed(1)}ms`,
        );
    }, 60000);

    it("should page newest first across more than one bounded type-index batch", async () => {
        const entries = Array.from({ length: 2102 }, (_, i) => ({
            event: message(`$file${i}`, i + 1, { msgtype: "m.file", filename: "report", body: "report" }),
            profile: {},
        }));
        await call("addHistoricEvents", entries, null, null);
        type Page = { events: Array<{ event: IEventWithRoomId }>; cursor?: string; exhausted: boolean };
        const query = { roomId: "!room:id", category: "files", term: "report", limit: 100 };
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 30; i++) {
            const page = await call<Page>("queryFileEvents", { ...query, cursor });
            ids.push(...page.events.map(({ event }) => event.event_id));
            if (page.exhausted) break;
            cursor = page.cursor;
        }
        expect(ids).toHaveLength(2102);
        expect(ids[0]).toBe("$file2101");
        expect(ids.at(-1)).toBe("$file0");
        expect(new Set(ids).size).toBe(ids.length);
    }, 60000);

    it("should merge attachment types by timestamp with stable pagination and accept a legacy cursor", async () => {
        await call(
            "addEventToIndex",
            message("$audio", 12, { msgtype: "m.audio", filename: "same", body: "same" }),
            {},
        );
        await call("addEventToIndex", message("$file", 12, { msgtype: "m.file", filename: "same", body: "same" }), {});
        await call("addEventToIndex", message("$older", 11, { msgtype: "m.file", filename: "same", body: "same" }), {});
        type Page = { events: Array<{ event: IEventWithRoomId }>; cursor?: string; exhausted: boolean };
        const query = { roomId: "!room:id", category: "files", term: "same", limit: 1 };
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 4; i++) {
            const page = await call<Page>("queryFileEvents", { ...query, cursor });
            ids.push(...page.events.map(({ event }) => event.event_id));
            if (page.exhausted) break;
            cursor = page.cursor;
        }
        expect(ids).toEqual(["$file", "$audio", "$older"]);
        const legacy = await call<Page>("queryFileEvents", {
            ...query,
            cursor: JSON.stringify({ key: ["!room:id", 12, "$audio"] }),
        });
        expect(legacy.events.map(({ event }) => event.event_id)).toEqual(["$older"]);
        await expect(
            call("queryFileEvents", { ...query, cursor: JSON.stringify({ key: ["!other:id", 12, "$audio"] }) }),
        ).rejects.toMatchObject({ code: "cursor_unavailable" });
    });

    it("should atomically replace a paged checkpoint and preserve its history root", async () => {
        const previous = { roomId: "!room:id", token: "root", rootToken: "root", direction: "b" };
        const next = { roomId: "!room:id", token: "older", rootToken: "root", direction: "b" };
        await call("addCrawlerCheckpoint", previous);
        await call(
            "addHistoricEvents",
            [{ event: message("$page", 1, { msgtype: "m.text", body: "page" }), profile: {} }],
            next,
            previous,
        );
        expect(await call<Array<{ roomId: string; token: string; rootToken?: string }>>("loadCheckpoints")).toEqual([
            expect.objectContaining({ roomId: "!room:id", token: "older", rootToken: "root" }),
        ]);
        await call("closeEventIndex");
        await call("initEventIndex", "@a:id", "device");
        expect(await call<Array<{ roomId: string; token: string; rootToken?: string }>>("loadCheckpoints")).toEqual([
            expect.objectContaining({ roomId: "!room:id", token: "older", rootToken: "root" }),
        ]);
    });

    it("should retain completed room boundaries after the worker database is reopened", async () => {
        await call("markRoomHistoryComplete", "!room:id", "live-token");
        await call("closeEventIndex");
        await call("initEventIndex", "@a:id", "device");
        expect(await call("getCompletedRoomToken", "!room:id")).toBe("live-token");
    });

    it("should repair a version 3 database missing stores and indexes without losing indexed data", async () => {
        await call("closeEventIndex");
        vi.stubGlobal("indexedDB", new IDBFactory());
        const name = "element-web-event-index-_40a_3Aid-device";
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 3);
            request.onupgradeneeded = () => {
                const db = request.result;
                const events = db.createObjectStore("events", { keyPath: "event_id" });
                events.createIndex("room_id", "room_id", { unique: true, multiEntry: true });
                events.createIndex("room_ts", ["room_id", "event_id"]);
                db.createObjectStore("checkpoints", { keyPath: ["room_id", "token", "direction"] });
                db.createObjectStore("meta", { keyPath: "key" });
                events.put({
                    event_id: "$legacy-v3",
                    room_id: "!room:id",
                    origin_server_ts: 10,
                    msgtype: "m.file",
                    event_json: JSON.stringify(message("$legacy-v3", 10, { msgtype: "m.file", filename: "legacy" })),
                    profile_json: "{}",
                });
                request.transaction!.objectStore("checkpoints").put({
                    room_id: "!room:id",
                    token: "older",
                    direction: "b",
                });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        legacy.close();

        await call("initEventIndex", "@a:id", "device");
        await call("setMaxEventAgeDays", 0);
        const page = await call<{ events: Array<{ event: IEventWithRoomId }> }>("queryFileEvents", {
            roomId: "!room:id",
            limit: 10,
            category: "files",
            term: "legacy",
        });
        expect(page.events.map(({ event }) => event.event_id)).toEqual(["$legacy-v3"]);
        expect(await call<Array<{ token: string }>>("loadCheckpoints")).toEqual([
            expect.objectContaining({ token: "older" }),
        ]);
        await call("addEventToIndex", message("$new-v4", 20, { msgtype: "m.file", filename: "new" }), {});
        expect(
            (
                await call<{ events: Array<{ event: IEventWithRoomId }> }>("queryFileEvents", {
                    roomId: "!room:id",
                    limit: 10,
                    category: "files",
                    term: "new",
                })
            ).events.map(({ event }) => event.event_id),
        ).toEqual(["$new-v4"]);
    });

    it("should preserve records in the legacy edits store during the v3 upgrade", async () => {
        await call("closeEventIndex");
        vi.stubGlobal("indexedDB", new IDBFactory());
        const name = "element-web-event-index-_40a_3Aid-device";
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 3);
            request.onupgradeneeded = () => {
                const db = request.result;
                const events = db.createObjectStore("events", { keyPath: "event_id" });
                events.createIndex("room_id", "room_id");
                events.createIndex("room_ts", ["room_id", "origin_server_ts", "event_id"]);
                events.createIndex("room_msgtype_ts", ["room_id", "msgtype", "origin_server_ts", "event_id"]);
                db.createObjectStore("checkpoints", { keyPath: ["room_id", "token", "direction"] });
                db.createObjectStore("meta", { keyPath: "key" });
                db.createObjectStore("redacted", { keyPath: "event_id" });
                db.createObjectStore("edits", { keyPath: "event_id" }).put({
                    event_id: "$old-target",
                    content_json: JSON.stringify({ body: "legacy edit" }),
                    timestamp: 42,
                });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        legacy.close();
        await call("initEventIndex", "@a:id", "device");
        await call("setMaxEventAgeDays", 0);
        await call("addEventToIndex", message("$old-target", 10, { msgtype: "m.text", body: "original body" }), {});
        const originalSearch = await call<{ results: unknown[] }>("searchEventIndex", {
            room_id: "!room:id",
            search_term: "original body",
            limit: 10,
            before_limit: 0,
            after_limit: 0,
        });
        const legacyEditSearch = await call<{ results: unknown[] }>("searchEventIndex", {
            room_id: "!room:id",
            search_term: "legacy edit",
            limit: 10,
            before_limit: 0,
            after_limit: 0,
        });
        expect(originalSearch.results).toHaveLength(1);
        expect(legacyEditSearch.results).toEqual([]);
        expect(await call<string[]>("getCompatibilityWarnings")).toEqual(["legacy_edits_unverified"]);
        await call("closeEventIndex");

        const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const tx = upgraded.transaction("edits", "readonly");
        const row = await new Promise<unknown>((resolve, reject) => {
            const request = tx.objectStore("edits").get("$old-target");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(row).toEqual({
            event_id: "$old-target",
            content_json: JSON.stringify({ body: "legacy edit" }),
            timestamp: 42,
        });
        expect(upgraded.objectStoreNames.contains("edit_relations")).toBe(true);
        upgraded.close();
    });

    it("should report an unrecoverable store key path without deleting the old database", async () => {
        await call("closeEventIndex");
        vi.stubGlobal("indexedDB", new IDBFactory());
        const name = "element-web-event-index-_40a_3Aid-device";
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 3);
            request.onupgradeneeded = () => {
                const db = request.result;
                const events = db.createObjectStore("events", { keyPath: "id" });
                events.put({ id: "$preserved" });
                db.createObjectStore("checkpoints", { keyPath: ["room_id", "token", "direction"] });
                db.createObjectStore("meta", { keyPath: "key" });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        legacy.close();

        await expect(call("initEventIndex", "@a:id", "device")).rejects.toMatchObject({
            code: "schema_error",
            operation: "initEventIndex",
            retryability: "reinitialize",
        });
        const preserved = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 3);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(preserved.version).toBe(3);
        const tx = preserved.transaction("events", "readonly");
        expect(
            await new Promise((resolve, reject) => {
                const request = tx.objectStore("events").get("$preserved");
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }),
        ).toEqual({ id: "$preserved" });
        preserved.close();
    });

    it("should preserve quota error metadata through the Worker response", async () => {
        vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
            throw new DOMException("private storage detail", "QuotaExceededError");
        });
        await expect(
            call("addEventToIndex", message("$quota", 10, { msgtype: "m.text", body: "private" }), {}),
        ).rejects.toMatchObject({
            code: "storage_error",
            operation: "addEventToIndex",
            retryability: "user_action",
            message: "The browser could not store local search data.",
        });
        vi.restoreAllMocks();
    });

    it("should upgrade an existing version 2 database without losing events or checkpoints", async () => {
        await call("closeEventIndex");
        vi.stubGlobal("indexedDB", new IDBFactory());
        const name = "element-web-event-index-_40a_3Aid-device";
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 2);
            request.onupgradeneeded = () => {
                const db = request.result;
                const events = db.createObjectStore("events", { keyPath: "event_id" });
                events.createIndex("room_ts", ["room_id", "origin_server_ts", "event_id"]);
                events.createIndex("room_id", "room_id");
                events.createIndex("room_msgtype_ts", ["room_id", "msgtype", "origin_server_ts", "event_id"]);
                db.createObjectStore("checkpoints", { keyPath: ["room_id", "token", "direction"] });
                db.createObjectStore("meta", { keyPath: "key" });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const tx = legacy.transaction(["events", "checkpoints"], "readwrite");
        tx.objectStore("events").put({
            event_id: "$legacy",
            room_id: "!room:id",
            origin_server_ts: 10,
            msgtype: "m.file",
            event_json: JSON.stringify(message("$legacy", 10, { msgtype: "m.file", filename: "legacy" })),
            profile_json: "{}",
        });
        tx.objectStore("checkpoints").put({ room_id: "!room:id", token: "older", direction: "b" });
        await new Promise<void>((resolve) => {
            tx.oncomplete = () => resolve();
        });
        legacy.close();
        await call("initEventIndex", "@a:id", "device");
        const page = await call<{ events: Array<{ event: IEventWithRoomId }> }>("queryFileEvents", {
            roomId: "!room:id",
            limit: 10,
            category: "files",
            term: "legacy",
        });
        expect(page.events.map(({ event }) => event.event_id)).toEqual(["$legacy"]);
        expect(await call<Array<{ token: string }>>("loadCheckpoints")).toEqual([
            expect.objectContaining({ token: "older" }),
        ]);
    });

    it("should apply an edit to the original event even if it arrives before historical insertion", async () => {
        await call("applyEventEdit", edit("$edit", "$original", 20));
        await call(
            "addHistoricEvents",
            [{ event: message("$original", 10, { msgtype: "m.text", body: "old body" }), profile: {} }],
            null,
            null,
        );
        const args = { room_id: "!room:id", search_term: "old body", limit: 10, before_limit: 0, after_limit: 0 };
        expect((await call<{ results: unknown[] }>("searchEventIndex", args)).results).toEqual([]);
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "new body" })).results,
        ).toHaveLength(1);
        await call("applyEventEdit", {
            ...edit("$stale-edit", "$original", 19),
            content: {
                "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
                "m.new_content": { msgtype: "m.text", body: "stale" },
            },
        });
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "stale" })).results,
        ).toEqual([]);
    });

    it("should validate edit room and sender and restore the original after edit redaction", async () => {
        await call(
            "addHistoricEvents",
            [{ event: message("$original", 10, { msgtype: "m.text", body: "original body" }), profile: {} }],
            null,
            null,
        );
        await call("applyEventEdit", edit("$other-sender", "$original", 20, "@other:id"));
        await call("applyEventEdit", edit("$other-room", "$original", 21, "@a:id", "!other:id"));
        const args = { room_id: "!room:id", search_term: "original body", limit: 10, before_limit: 0, after_limit: 0 };
        expect((await call<{ results: unknown[] }>("searchEventIndex", args)).results).toHaveLength(1);
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "new body" })).results,
        ).toEqual([]);

        await call("applyEventEdit", edit("$valid-edit", "$original", 22));
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "new body" })).results,
        ).toHaveLength(1);
        await call("deleteEvent", "$valid-edit");
        expect((await call<{ results: unknown[] }>("searchEventIndex", args)).results).toHaveLength(1);
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "new body" })).results,
        ).toEqual([]);
    });

    it("should ignore an out-of-order edit from another sender when the original is later indexed", async () => {
        await call("applyEventEdit", edit("$early-edit", "$original", 20, "@other:id"));
        await call(
            "addHistoricEvents",
            [{ event: message("$original", 10, { msgtype: "m.text", body: "original body" }), profile: {} }],
            null,
            null,
        );
        const args = { room_id: "!room:id", search_term: "original body", limit: 10, before_limit: 0, after_limit: 0 };
        expect((await call<{ results: unknown[] }>("searchEventIndex", args)).results).toHaveLength(1);
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "new body" })).results,
        ).toEqual([]);
    });

    it("should keep redactions across later historical inserts and replace re-decrypted events", async () => {
        await call("deleteEvent", "$redacted");
        await call(
            "addHistoricEvents",
            [{ event: message("$redacted", 1, { msgtype: "m.text", body: "secret" }), profile: {} }],
            null,
            null,
        );
        const args = { room_id: "!room:id", search_term: "secret", limit: 10, before_limit: 0, after_limit: 0 };
        expect((await call<{ results: unknown[] }>("searchEventIndex", args)).results).toEqual([]);
        await call("addEventToIndex", message("$edit", 2, { msgtype: "m.text", body: "old" }), {});
        await call("addEventToIndex", message("$edit", 2, { msgtype: "m.text", body: "new" }), {});
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "old" })).results,
        ).toEqual([]);
        expect(
            (await call<{ results: unknown[] }>("searchEventIndex", { ...args, search_term: "new" })).results,
        ).toHaveLength(1);
    });
});
