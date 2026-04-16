/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";

describe("webEventIndex.worker", () => {
    beforeEach(() => {
        jest.resetModules();
        Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            value: new IDBFactory(),
        });
        (self as any).postMessage = jest.fn();
    });

    async function loadWorker(): Promise<(event: MessageEvent) => Promise<void>> {
        await import("../../../../src/indexing/web/webEventIndex.worker");
        return (self as any).onmessage;
    }

    async function send(
        onmessage: (event: MessageEvent) => Promise<void>,
        id: number,
        name: string,
        ...args: any[]
    ): Promise<any> {
        await onmessage({ data: { id, name, args } } as MessageEvent);
        expect((self as any).postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id }));
        return ((self as any).postMessage as jest.Mock).mock.calls.at(-1)?.[0];
    }

    it("rebuilds the database when initialization hits a recoverable IndexedDB open failure", async () => {
        const realOpen = indexedDB.open.bind(indexedDB);
        const openSpy = jest.spyOn(indexedDB, "open");

        openSpy.mockImplementation(((name: string, version?: number) => {
            openSpy.mockImplementation(realOpen);
            const request = {
                result: undefined,
                error: new DOMException("Corrupted IndexedDB", "UnknownError"),
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
            } as unknown as IDBOpenDBRequest;
            queueMicrotask(() => {
                request.onerror?.(new Event("error") as Event);
            });
            return request;
        }) as typeof indexedDB.open);

        const onmessage = await loadWorker();
        const response = await send(onmessage, 1, "initEventIndex", "@alice:server", "DEVICE");

        expect(response).toEqual({ id: 1, reply: undefined });
        expect(openSpy).toHaveBeenCalledTimes(2);
    });

    it("stores live events on commit and keeps queued writes out of the index before commit", async () => {
        const onmessage = await loadWorker();
        const now = Date.now();

        await send(onmessage, 1, "initEventIndex", "@alice:server", "DEVICE");

        await send(
            onmessage,
            2,
            "addEventToIndex",
            {
                event_id: "$one",
                room_id: "!room:server",
                sender: "@alice:server",
                origin_server_ts: now - 1000,
                type: "m.room.message",
                content: { body: "hello one", msgtype: "m.text" },
            },
            { displayname: "Alice" },
        );
        await send(
            onmessage,
            3,
            "addEventToIndex",
            {
                event_id: "$two",
                room_id: "!room:server",
                sender: "@alice:server",
                origin_server_ts: now,
                type: "m.room.message",
                content: { body: "hello two", msgtype: "m.text" },
            },
            { displayname: "Alice" },
        );

        expect(await send(onmessage, 4, "isEventIndexEmpty")).toEqual({ id: 4, reply: true });

        await send(onmessage, 5, "commitLiveEvents");

        expect(await send(onmessage, 6, "isEventIndexEmpty")).toEqual({ id: 6, reply: false });
        expect(
            await send(onmessage, 7, "searchEventIndex", {
                search_term: "hello",
                before_limit: 0,
                after_limit: 0,
                order_by_recency: true,
                room_id: "!room:server",
                limit: 10,
            }),
        ).toEqual(
            expect.objectContaining({
                id: 7,
                reply: expect.objectContaining({
                    count: 2,
                    results: expect.arrayContaining([
                        expect.objectContaining({ result: expect.objectContaining({ event_id: "$two" }) }),
                        expect.objectContaining({ result: expect.objectContaining({ event_id: "$one" }) }),
                    ]),
                }),
            }),
        );
    });
});
