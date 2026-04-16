/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import workerFactory from "../../../../src/indexing/web/webEventIndexWorkerFactory";
import { WebEventIndexManager } from "../../../../src/indexing/web/WebEventIndexManager";
import SdkConfig from "../../../../src/SdkConfig";

jest.mock("../../../../src/indexing/web/webEventIndexWorkerFactory", () => ({
    __esModule: true,
    default: jest.fn(),
}));

describe("WebEventIndexManager", () => {
    let postedMessages: Array<{ id: number; name: string; args: any[] }>;
    let worker: Worker & { onmessage: ((event: MessageEvent) => void) | null };
    const mockWorkerFactory = jest.mocked(workerFactory);

    beforeEach(() => {
        postedMessages = [];
        worker = {
            postMessage: jest.fn((message) => {
                postedMessages.push(message);
            }),
            terminate: jest.fn(),
            onmessage: null,
            onerror: null,
        } as unknown as Worker & { onmessage: ((event: MessageEvent) => void) | null };

        mockWorkerFactory.mockReturnValue(worker);
        jest.spyOn(SdkConfig, "get").mockReturnValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        mockWorkerFactory.mockReset();
    });

    function replyLast(reply: unknown): void {
        const request = postedMessages.at(-1)!;
        worker.onmessage?.({ data: { id: request.id, reply } } as MessageEvent);
    }

    it("initializes the worker and forwards the configured max event age", async () => {
        jest.spyOn(SdkConfig, "get").mockReturnValue(30);
        const manager = new WebEventIndexManager();

        const initPromise = manager.initEventIndex("@alice:server", "DEVICE");
        expect(postedMessages).toEqual([{ id: 1, name: "initEventIndex", args: ["@alice:server", "DEVICE"] }]);

        worker.onmessage?.({ data: { id: 1, reply: undefined } } as MessageEvent);
        await Promise.resolve();
        expect(postedMessages[1]).toEqual({ id: 2, name: "setMaxEventAgeDays", args: [30] });

        replyLast(undefined);
        await initPromise;
    });

    it("proxies search requests through the worker", async () => {
        const manager = new WebEventIndexManager();
        const searchArgs = {
            search_term: "hello",
            before_limit: 1,
            after_limit: 2,
            order_by_recency: true,
            room_id: "!room:server",
            limit: 20,
        };

        const searchPromise = manager.searchEventIndex(searchArgs);

        expect(postedMessages).toEqual([{ id: 1, name: "searchEventIndex", args: [searchArgs] }]);

        const result = { results: [], highlights: ["hello"], count: 0 };
        replyLast(result);

        await expect(searchPromise).resolves.toEqual(result);
    });

    it("queues index writes and commits them through the worker", async () => {
        const manager = new WebEventIndexManager();
        const event = {
            event_id: "$event",
            room_id: "!room:server",
            sender: "@alice:server",
            origin_server_ts: 1,
            type: "m.room.message",
            content: { body: "hello", msgtype: "m.text" },
        };
        const profile = { displayname: "Alice" };

        const addPromise = manager.addEventToIndex(event as any, profile);
        expect(postedMessages).toEqual([{ id: 1, name: "addEventToIndex", args: [event, profile] }]);
        replyLast(undefined);
        await addPromise;

        const commitPromise = manager.commitLiveEvents();
        expect(postedMessages[1]).toEqual({ id: 2, name: "commitLiveEvents", args: [] });
        replyLast(undefined);
        await commitPromise;
    });
});
