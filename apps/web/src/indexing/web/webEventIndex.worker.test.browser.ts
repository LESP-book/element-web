/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it } from "vitest";
import type { IEventWithRoomId } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../../SdkConfig";
import workerFactory from "./webEventIndexWorkerFactory";
import { WebEventIndexManager } from "./WebEventIndexManager";
import { WebEventIndexError } from "./WebEventIndexError";

/** Exercise the actual Web Worker and browser IndexedDB rather than an in-process mock. */
describe("Web event index worker in Chromium", () => {
    beforeEach(() => SdkConfig.reset());
    it("should find a file by filename, retain a completed token, and exclude a redacted message", async () => {
        const worker = workerFactory({ type: "module" });
        let nextId = 0;
        const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
            new Promise((resolve, reject) => {
                const id = ++nextId;
                const onMessage = (event: MessageEvent<{ id: number; reply?: T; error?: string }>): void => {
                    if (event.data.id !== id) return;
                    worker.removeEventListener("message", onMessage);
                    if (event.data.error) reject(new Error(event.data.error));
                    else resolve(event.data.reply as T);
                };
                worker.addEventListener("message", onMessage);
                worker.postMessage({ id, name, args });
            });
        try {
            // An isolated, new test database in this browser context; never open or delete user data.
            await call("initEventIndex", `@search-test-${crypto.randomUUID()}:example.org`, "test-device");
            await call("setMaxEventAgeDays", 0);
            const event = {
                event_id: "$file",
                room_id: "!test:example.org",
                sender: "@test:example.org",
                origin_server_ts: 1,
                type: "m.room.message",
                content: { msgtype: "m.file", filename: "合同.pdf", body: "attachment", url: "mxc://example.org/a" },
            };
            await call("addEventToIndex", event, {});
            const query = { roomId: event.room_id, category: "files", term: "合同", limit: 10 };
            const page = await call<{ events: Array<{ event: { event_id: string } }> }>("queryFileEvents", query);
            expect(page.events.map(({ event }) => event.event_id)).toEqual(["$file"]);
            await call(
                "addEventToIndex",
                {
                    ...event,
                    event_id: "$other",
                    sender: "@someone:example.org",
                    origin_server_ts: 20,
                },
                {},
            );
            const filtered = await call<typeof page>("queryFileEvents", {
                ...query,
                sender: event.sender,
                fromTs: 1,
                toTs: 2,
                msgtype: "m.file",
            });
            expect(filtered.events.map(({ event }) => event.event_id)).toEqual(["$file"]);
            expect((await call<typeof page>("queryFileEvents", { ...query, msgtype: "m.audio" })).events).toEqual([]);
            expect((await call<typeof page>("queryFileEvents", { ...query, fromTs: 30, toTs: 2 })).events).toEqual([]);
            await call("markRoomHistoryComplete", event.room_id, "live-token");
            expect(await call("getCompletedRoomToken", event.room_id)).toBe("live-token");
            await call("deleteEvent", "$file");
            expect((await call<typeof page>("queryFileEvents", { ...query, sender: event.sender })).events).toEqual([]);
        } finally {
            await call("closeEventIndex");
            worker.terminate();
        }
    });

    it("returns the original and valid revisions across indexed edit withdrawals", async () => {
        const manager = new WebEventIndexManager();
        const userId = `@edits-${crypto.randomUUID()}:example.org`;
        const roomId = "!edits:example.org";
        const sender = "@edits:example.org";
        const original = {
            event_id: "$attachment",
            room_id: roomId,
            sender,
            origin_server_ts: Date.now() - 3_000,
            type: "m.room.message",
            content: { msgtype: "m.file", filename: "other.pdf", body: "other.pdf" },
        };
        const edit = (id: string, timestamp: number, filename: string): IEventWithRoomId => ({
            ...original,
            event_id: id,
            origin_server_ts: timestamp,
            content: {
                "msgtype": "m.file",
                "body": filename,
                "m.relates_to": { rel_type: "m.replace", event_id: original.event_id },
                "m.new_content": { msgtype: "m.file", filename, body: filename },
            },
        });
        try {
            // Fresh fixture only; never alter a browser user's account database.
            await manager.initEventIndex(userId, "fixture-device");
            await manager.addEventToIndex(original, {});
            await manager.applyEventEdit(edit("$e1", original.origin_server_ts + 1_000, "report-v1.pdf"));
            await manager.applyEventEdit(edit("$e2", original.origin_server_ts + 2_000, "report-v2.pdf"));
            const query = { roomId, category: "files" as const, term: "report", limit: 10 };
            const latest = await manager.queryFileEvents(query);
            expect(latest.events[0].event.content.filename).toBe("report-v2.pdf");
            expect(latest.events[0].original_event?.content.filename).toBe("other.pdf");
            expect(latest.events[0].file_edits?.map(({ event_id }) => event_id)).toEqual(["$e1", "$e2"]);
            await manager.deleteEvent("$e2");
            const previous = await manager.queryFileEvents(query);
            expect(previous.events[0].event.content.filename).toBe("report-v1.pdf");
            expect(previous.events[0].file_edits?.map(({ event_id }) => event_id)).toEqual(["$e1"]);
            await manager.deleteEvent("$e1");
            expect((await manager.queryFileEvents(query)).events).toEqual([]);
            const restored = await manager.queryFileEvents({ ...query, term: "other" });
            expect(restored.events[0].original_event?.content.filename).toBe("other.pdf");
        } finally {
            await manager.closeEventIndex();
        }
    });

    it("should release an open IndexedDB connection when its Worker is terminated", async () => {
        const userId = `@termination-test-${crypto.randomUUID()}:example.org`;
        const deviceId = "test-device";
        const encode = (value: string): string => encodeURIComponent(value).replace(/%/g, "_");
        const name = `element-web-event-index-${encode(userId)}-${encode(deviceId)}`;
        const worker = workerFactory({ type: "module" });
        let nextId = 0;
        const call = <T>(operation: string, ...args: unknown[]): Promise<T> =>
            new Promise((resolve, reject) => {
                const id = ++nextId;
                const onMessage = (event: MessageEvent<{ id: number; reply?: T; error?: string }>): void => {
                    if (event.data.id !== id) return;
                    worker.removeEventListener("message", onMessage);
                    if (event.data.error) reject(new Error(event.data.error));
                    else resolve(event.data.reply as T);
                };
                worker.addEventListener("message", onMessage);
                worker.postMessage({ id, name: operation, args });
            });
        await call("initEventIndex", userId, deviceId);
        worker.terminate();

        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => {
                expect(request.result).toBeUndefined();
                resolve();
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("Worker termination left the IndexedDB connection open"));
        });
    });

    it("should migrate the known v3 event format and preserve its user-version upgrade capability", async () => {
        const userId = `@legacy-test-${crypto.randomUUID()}:example.org`;
        const deviceId = "test-device";
        const encode = (value: string): string => encodeURIComponent(value).replace(/%/g, "_");
        const name = `element-web-event-index-${encode(userId)}-${encode(deviceId)}`;
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 3);
            request.onupgradeneeded = () => {
                const database = request.result;
                const events = database.createObjectStore("events", { keyPath: "event_id" });
                events.createIndex("room_id", "room_id", { unique: true });
                database.createObjectStore("checkpoints", { keyPath: ["room_id", "token", "direction"] }).put({
                    room_id: "!legacy:example.org",
                    token: "older",
                    direction: "b",
                });
                database.createObjectStore("meta", { keyPath: "key" });
                database.createObjectStore("edits", { keyPath: "event_id" }).put({
                    event_id: "$legacy-file",
                    content_json: JSON.stringify({ body: "unverified" }),
                    timestamp: 1,
                });
                events.put({
                    event_id: "$legacy-file",
                    room_id: "!legacy:example.org",
                    // Older records may lack a projected sender even when event_json contains it.
                    origin_server_ts: 10,
                    type: "m.room.message",
                    msgtype: "m.file",
                    event_json: JSON.stringify({
                        event_id: "$legacy-file",
                        room_id: "!legacy:example.org",
                        sender: "@legacy:example.org",
                        origin_server_ts: 10,
                        type: "m.room.message",
                        content: { msgtype: "m.file", filename: "legacy.pdf", body: "original" },
                    }),
                    profile_json: "{}",
                });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        legacy.close();

        const manager = new WebEventIndexManager();
        try {
            await manager.initEventIndex(userId, deviceId);
            expect(await manager.getUserVersion()).toBe(0);
            expect(manager.canUpgradeUserVersion(0, 1)).toBe(true);
            expect(await manager.loadCheckpoints()).toEqual([
                expect.objectContaining({ roomId: "!legacy:example.org", token: "older" }),
            ]);
            const legacyFiles = await manager.queryFileEvents({
                roomId: "!legacy:example.org",
                category: "files",
                term: "legacy.pdf",
                limit: 10,
            });
            expect(legacyFiles.events.map(({ event }) => event.event_id)).toEqual(["$legacy-file"]);
            const bySender = await manager.queryFileEvents({
                roomId: "!legacy:example.org",
                category: "files",
                term: "legacy.pdf",
                limit: 10,
                sender: "@legacy:example.org",
            });
            expect(bySender.events.map(({ event }) => event.event_id)).toEqual(["$legacy-file"]);
            expect(await manager.getCompatibilityWarnings()).toEqual(["legacy_edits_unverified"]);
        } finally {
            await manager.closeEventIndex();
        }
    });

    it("should fail closed for nonempty v4 data without a supported legacy schema marker", async () => {
        const userId = `@unknown-format-${crypto.randomUUID()}:example.org`;
        const deviceId = "test-device";
        const manager = new WebEventIndexManager();
        try {
            await manager.initEventIndex(userId, deviceId);
            await manager.addEventToIndex(
                {
                    event_id: "$unknown-format",
                    room_id: "!unknown:example.org",
                    sender: "@unknown:example.org",
                    origin_server_ts: Date.now(),
                    type: "m.room.message",
                    content: { msgtype: "m.file", body: "original", filename: "kept.pdf" },
                },
                {},
            );
            await manager.closeEventIndex();
            const encode = (value: string): string => encodeURIComponent(value).replace(/%/g, "_");
            const name = `element-web-event-index-${encode(userId)}-${encode(deviceId)}`;
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(name);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            const transaction = database.transaction("meta", "readwrite");
            const finished = new Promise<void>((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onabort = () => reject(transaction.error);
                transaction.onerror = () => reject(transaction.error);
            });
            transaction.objectStore("meta").delete("schema_source_version");
            await finished;
            database.close();
            await manager.initEventIndex(userId, deviceId);

            expect(await manager.isEventIndexEmpty()).toBe(false);
            expect(await manager.getUserVersion()).toBe(0);
            expect(manager.canUpgradeUserVersion(0, 1)).toBe(false);
            const retainedFiles = await manager.queryFileEvents({
                roomId: "!unknown:example.org",
                category: "files",
                term: "kept.pdf",
                limit: 10,
            });
            expect(retainedFiles.events.map(({ event }) => event.event_id)).toEqual(["$unknown-format"]);
        } finally {
            await manager.closeEventIndex();
        }
    });

    it("should preserve a version error through the production Worker RPC decoder", async () => {
        const userId = `@version-test-${crypto.randomUUID()}:example.org`;
        const deviceId = "test-device";
        const encode = (value: string): string => encodeURIComponent(value).replace(/%/g, "_");
        const name = `element-web-event-index-${encode(userId)}-${encode(deviceId)}`;
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 5);
            request.onupgradeneeded = () => {};
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        database.close();

        const manager = new WebEventIndexManager();
        const error = await manager.initEventIndex(userId, deviceId).then(
            () => null,
            (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(WebEventIndexError);
        expect(error).toMatchObject({
            code: "version_incompatible",
            operation: "initEventIndex",
            retryability: "user_action",
        });
        expect((error as WebEventIndexError).message).toBe("The local event index version is not compatible.");
        await manager.closeEventIndex();
    });
});
