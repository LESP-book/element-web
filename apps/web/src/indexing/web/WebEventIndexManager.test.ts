/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import SdkConfig from "../../SdkConfig";
import { WebEventIndexManager } from "./WebEventIndexManager";
import { WEB_EVENT_INDEX_WORKER_OPERATIONS, WebEventIndexError } from "./WebEventIndexError";

const fakeWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onerror: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
};

vi.mock("./webEventIndexWorkerFactory", () => ({ default: () => fakeWorker }));
afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

async function initManager(manager: WebEventIndexManager, userId = "@test:example.org"): Promise<void> {
    if (!vi.isMockFunction(SdkConfig.get)) vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
    const initializing = manager.initEventIndex(userId, "device");
    const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
    fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
    await initializing;
}

describe("WebEventIndexManager worker RPC", () => {
    it("should retire timed-out requests as one generation without leaving timers on a replacement", async () => {
        const manager = new WebEventIndexManager();
        vi.useFakeTimers();
        try {
            const first = manager.supportsEventIndexing();
            const second = manager.supportsEventIndexing();
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(first).resolves.toBe(false);
            await expect(second).resolves.toBe(false);
            expect(fakeWorker.terminate).toHaveBeenCalledOnce();
            const rpc = (manager as unknown as { rpc: { retireFailedGeneration: () => string } }).rpc;
            const retired = rpc.retireFailedGeneration();
            expect(retired).toBe("retired");
            expect(fakeWorker.terminate).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(fakeWorker.terminate).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("should drain and retire account A requests before initializing account B", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name?: string; args?: unknown[] };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountAInit;

        const accountAQuery = manager.queryFileEvents({
            roomId: "!a:example.org",
            category: "files",
            limit: 10,
            term: "private-a-term",
        });
        const staleResult = accountAQuery.catch((error: unknown) => error);
        const accountBInit = manager.initEventIndex("@b:example.org", "device-b");
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args?: unknown[] };
        expect(request.name).toBe("queryFileEvents");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: { events: [] } } } as MessageEvent);
        await expect(staleResult).resolves.toMatchObject({ code: "cancelled", retryability: "never" });

        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountBInit;
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "queryFileEvents",
            "closeEventIndex",
            "initEventIndex",
        ]);
    });

    it("should retain account A and retry its close after a failed account switch", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@a:example.org");

        const switching = manager.initEventIndex("@b:example.org", "device-b");
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        const failedClose = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({
            data: {
                id: failedClose.id,
                error: {
                    code: "storage_error",
                    operation: "closeEventIndex",
                    retryability: "never",
                },
            },
        } as MessageEvent);
        await expect(switching).rejects.toMatchObject({ code: "storage_error" });
        expect(fakeWorker.terminate).not.toHaveBeenCalled();
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);

        const retry = manager.initEventIndex("@b:example.org", "device-b");
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        const retriedClose = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: retriedClose.id, reply: undefined } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await retry;
        expect(fakeWorker.terminate).toHaveBeenCalledOnce();
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "closeEventIndex",
            "closeEventIndex",
            "initEventIndex",
        ]);
    });

    it("should not restore a binding after the Worker fails during replacement drain", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@a:example.org");
        const pendingARequest = manager.getUserVersion();
        const switching = manager.initEventIndex("@b:example.org", "device-b");
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);

        fakeWorker.onerror?.(new Event("error"));
        await expect(pendingARequest).rejects.toMatchObject({ code: "cancelled" });
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await switching;
        expect(fakeWorker.terminate).toHaveBeenCalledTimes(2);

        const readingB = manager.getUserVersion();
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4));
        const readRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: readRequest.id, reply: 1 } } as MessageEvent);
        await expect(readingB).resolves.toBe(1);
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "getUserVersion",
            "initEventIndex",
            "getUserVersion",
        ]);
    });

    it("should treat Worker termination during A's close RPC as successful retirement", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@a:example.org");
        const switching = manager.initEventIndex("@b:example.org", "device-b");
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });

        fakeWorker.onerror?.(new Event("error"));
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await switching;
        expect(fakeWorker.terminate).toHaveBeenCalledTimes(2);
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "closeEventIndex",
            "initEventIndex",
        ]);

        const readingB = manager.getUserVersion();
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4));
        const readRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: readRequest.id, reply: 1 } } as MessageEvent);
        await expect(readingB).resolves.toBe(1);
    });

    it("should allow the old init to finish its configured setup before switching accounts", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(14);
        const manager = new WebEventIndexManager();
        const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
        const accountBInit = manager.initEventIndex("@b:example.org", "device-b");
        expect(fakeWorker.postMessage).toHaveBeenCalledOnce();

        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name?: string; args?: unknown[] };
        expect(request.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("setMaxEventAgeDays");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request.args).toEqual([14]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);

        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(5);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("setMaxEventAgeDays");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(request.args).toEqual([14]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await Promise.all([accountAInit, accountBInit]);
    });

    it("should wait for B initialization before applying a queued close across the replacement gap", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args?: unknown[] };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountAInit;

        const initializeB = manager.initEventIndex.bind(manager);
        let bInitializationCount = 0;
        let releaseB!: () => void;
        const delayedB = new Promise<void>((resolve) => {
            releaseB = resolve;
        });
        vi.spyOn(manager, "initEventIndex").mockImplementation((userId, deviceId) => {
            if (userId === "@b:example.org" && ++bInitializationCount === 2) {
                return delayedB.then(() => initializeB(userId, deviceId));
            }
            return initializeB(userId, deviceId);
        });

        const switching = manager.initEventIndex("@b:example.org", "device-b");
        const closing = manager.closeEventIndex();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);

        releaseB();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await Promise.all([switching, closing]);
    });

    it.each(["closeEventIndex", "deleteEventIndex"] as const)(
        "should wait for B's configured setup before applying queued %s",
        async (operation) => {
            vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
            const manager = new WebEventIndexManager();
            await initManager(manager, "@a:example.org");
            vi.spyOn(SdkConfig, "get").mockReturnValue(14);

            const switching = manager.initEventIndex("@b:example.org", "device-b");
            const terminating =
                operation === "closeEventIndex" ? manager.closeEventIndex() : manager.deleteEventIndex();
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(
                    "closeEventIndex",
                );
            });
            let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args?: unknown[] };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
            expect(request.args).toEqual(["@b:example.org", "device-b"]);
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(
                    "setMaxEventAgeDays",
                );
            });
            // The Worker is initialized but B's configured setup is still pending.
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
            expect(request.args).toEqual([14]);
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(5);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(operation);
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await Promise.all([switching, terminating]);
            expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
                "initEventIndex",
                "closeEventIndex",
                "initEventIndex",
                "setMaxEventAgeDays",
                operation,
            ]);
        },
    );

    it.each(["closeEventIndex", "deleteEventIndex"] as const)(
        "should never redirect a queued %s for B to a later account C",
        async (operation) => {
            vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
            const manager = new WebEventIndexManager();
            await initManager(manager, "@a:example.org");
            const switchingB = manager.initEventIndex("@b:example.org", "device-b");
            const terminatingB =
                operation === "closeEventIndex" ? manager.closeEventIndex() : manager.deleteEventIndex();
            await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2));
            let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args?: unknown[] };
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3));
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
            expect(request.args).toEqual(["@b:example.org", "device-b"]);
            // B has a provisional binding, but its Worker initialization has not completed.
            const switchingC = manager.initEventIndex("@c:example.org", "device-c");
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
            await switchingB;
            await expect(terminatingB).rejects.toMatchObject({ code: "cancelled", operation });
            await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4));
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(5));
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
            expect(request.args).toEqual(["@c:example.org", "device-c"]);
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
            await switchingC;
            expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
                "initEventIndex",
                "closeEventIndex",
                "initEventIndex",
                "closeEventIndex",
                "initEventIndex",
            ]);
            const readingC = manager.getUserVersion();
            await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(6));
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 1 } } as MessageEvent);
            await expect(readingC).resolves.toBe(1);
        },
    );

    it("should delete B after its configured setup fails when delete was queued behind replacement", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@a:example.org");
        vi.spyOn(SdkConfig, "get").mockReturnValue(14);

        const switching = manager.initEventIndex("@b:example.org", "device-b");
        const deleting = manager.deleteEventIndex();
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2));
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3));
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4));
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("setMaxEventAgeDays");
        fakeWorker.onmessage?.({
            data: {
                id: request.id,
                error: { code: "storage_error", operation: "setMaxEventAgeDays", retryability: "never" },
            },
        } as MessageEvent);
        await expect(switching).rejects.toMatchObject({ code: "storage_error" });
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(5);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("deleteEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await expect(deleting).resolves.toBeUndefined();
        await expect(manager.getUserVersion()).rejects.toMatchObject({ code: "cancelled" });
    });

    it("should reject a direct close in the unbound replacement gap", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountAInit;

        const initializeB = manager.initEventIndex.bind(manager);
        let bInitializationCount = 0;
        let releaseB!: () => void;
        let gapCloseResult: Promise<unknown> | undefined;
        const delayedB = new Promise<void>((resolve) => {
            releaseB = resolve;
        });
        vi.spyOn(manager, "initEventIndex").mockImplementation((userId, deviceId) => {
            if (userId === "@b:example.org" && ++bInitializationCount === 2) {
                gapCloseResult = manager.closeEventIndex().catch((error: unknown) => error);
                return delayedB.then(() => initializeB(userId, deviceId));
            }
            return initializeB(userId, deviceId);
        });

        const switching = manager.initEventIndex("@b:example.org", "device-b");
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await vi.waitFor(() => expect(gapCloseResult).toBeDefined());
        const gapClose = gapCloseResult;
        if (!gapClose) throw new Error("Expected close to run during the replacement gap");
        await expect(gapClose).resolves.toMatchObject({ code: "cancelled", operation: "closeEventIndex" });
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);

        releaseB();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await switching;
    });

    it("should preserve close-before-switch ordering when both are requested in the same turn", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name?: string; args?: unknown[] };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountAInit;

        const closeA = manager.closeEventIndex();
        const accountBInit = manager.initEventIndex("@b:example.org", "device-b");
        expect(fakeWorker.postMessage).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("closeEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await closeA;

        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountBInit;

        const readingB = manager.getUserVersion();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("getUserVersion");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 1 } } as MessageEvent);
        await expect(readingB).resolves.toBe(1);
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "closeEventIndex",
            "initEventIndex",
            "getUserVersion",
        ]);
    });

    it.each(["closeEventIndex", "deleteEventIndex"] as const)(
        "should serialize same-tick account switches and %s against one lifecycle reservation",
        async (operation) => {
            vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
            const manager = new WebEventIndexManager();
            const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
            let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args?: unknown[] };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
            await accountAInit;

            const firstSwitch = manager.initEventIndex("@b:example.org", "device-b");
            const secondSwitch = manager.initEventIndex("@b:example.org", "device-b");
            const termination =
                operation === "closeEventIndex" ? manager.closeEventIndex() : manager.deleteEventIndex();
            expect(fakeWorker.postMessage).toHaveBeenCalledOnce();

            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(
                    "closeEventIndex",
                );
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);

            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
            expect(request.args).toEqual(["@b:example.org", "device-b"]);
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);

            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(operation);
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await Promise.all([firstSwitch, secondSwitch, termination]);
            await expect(manager.getUserVersion()).rejects.toMatchObject({ code: "cancelled" });
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect(manager.canUpgradeUserVersion(0, 1)).toBe(false);
            expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
                "initEventIndex",
                "closeEventIndex",
                "initEventIndex",
                operation,
            ]);
        },
    );

    it("should single-flight concurrent initialization for the same binding", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const first = manager.initEventIndex("@same:example.org", "device");
        const second = manager.initEventIndex("@same:example.org", "device");
        expect(first).toBe(second);
        expect(fakeWorker.postMessage).toHaveBeenCalledOnce();
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(manager.canUpgradeUserVersion(0, 1)).toBe(true);
    });

    it("should allow the stateless capability probe to overlap initial binding", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const supports = manager.supportsEventIndexing();
        const initializing = manager.initEventIndex("@probe:example.org", "device");
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);

        const supportRequest = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; name: string };
        const initRequest = fakeWorker.postMessage.mock.calls[1]?.[0] as { id: number; name: string };
        expect(supportRequest.name).toBe("supportsEventIndexing");
        expect(initRequest.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: initRequest.id, reply: 3 } } as MessageEvent);
        fakeWorker.onmessage?.({ data: { id: supportRequest.id, reply: true } } as MessageEvent);
        await expect(supports).resolves.toBe(true);
        await initializing;
    });

    it("should leave an unbound Worker capability probe untouched by close or delete", async () => {
        const manager = new WebEventIndexManager();
        const supports = manager.supportsEventIndexing();
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("supportsEventIndexing");
        await manager.closeEventIndex();
        await manager.deleteEventIndex();
        expect(fakeWorker.postMessage).toHaveBeenCalledOnce();
        fakeWorker.onmessage?.({ data: { id: request.id, reply: true } } as MessageEvent);
        await expect(supports).resolves.toBe(true);
    });

    it("should wait for initialization before sending the close request", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@close:example.org", "device");
        const initRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(initRequest.name).toBe("initEventIndex");

        const closing = manager.closeEventIndex();
        expect(fakeWorker.postMessage).toHaveBeenCalledOnce();
        fakeWorker.onmessage?.({ data: { id: initRequest.id, reply: 3 } } as MessageEvent);
        await initializing;
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        const closeRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: closeRequest.id, reply: undefined } } as MessageEvent);
        await expect(closing).resolves.toBeUndefined();
    });

    it.each(["closeEventIndex", "deleteEventIndex"] as const)(
        "should run %s after initialization fails before returning a schema version",
        async (operation) => {
            vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
            const manager = new WebEventIndexManager();
            const initializing = manager.initEventIndex("@failed-init:example.org", "device");
            const termination =
                operation === "closeEventIndex" ? manager.closeEventIndex() : manager.deleteEventIndex();
            const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
            expect(request.name).toBe("initEventIndex");
            fakeWorker.onmessage?.({
                data: {
                    id: request.id,
                    error: {
                        code: "storage_error",
                        operation: "initEventIndex",
                        retryability: "never",
                    },
                },
            } as MessageEvent);

            await expect(initializing).rejects.toMatchObject({ code: "storage_error" });
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(operation);
            });
            const cleanup = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({ data: { id: cleanup.id, reply: undefined } } as MessageEvent);
            await expect(termination).resolves.toBeUndefined();
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
        },
    );

    it.each(["closeEventIndex", "deleteEventIndex"] as const)(
        "should run %s after configured setup fails following Worker initialization",
        async (operation) => {
            vi.spyOn(SdkConfig, "get").mockReturnValue(14);
            const manager = new WebEventIndexManager();
            const initializing = manager.initEventIndex("@failed-setup:example.org", "device");
            const termination =
                operation === "closeEventIndex" ? manager.closeEventIndex() : manager.deleteEventIndex();
            let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name?: string };
            expect(request.name).toBe("initEventIndex");
            fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(
                    "setMaxEventAgeDays",
                );
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({
                data: {
                    id: request.id,
                    error: {
                        code: "storage_error",
                        operation: "setMaxEventAgeDays",
                        retryability: "never",
                    },
                },
            } as MessageEvent);
            await expect(initializing).rejects.toMatchObject({ code: "storage_error" });
            await vi.waitFor(() => {
                expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
                expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe(operation);
            });
            request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
            fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
            await expect(termination).resolves.toBeUndefined();
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
        },
    );

    it("should drain an ordinary Worker request before closing its binding", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@close:example.org", "device");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await initializing;

        const reading = manager.getUserVersion();
        const close = manager.closeEventIndex();
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("getUserVersion");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 1 } } as MessageEvent);
        await expect(reading).resolves.toBe(1);

        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await expect(close).resolves.toBeUndefined();
    });

    it("should not recover a failed in-flight request while close is draining", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@close:example.org");
        const pending = manager.getUserVersion();
        const close = manager.closeEventIndex();
        fakeWorker.onerror?.(new Event("error"));

        await expect(pending).rejects.toMatchObject({ code: "cancelled", retryability: "never" });
        await expect(close).rejects.toMatchObject({ code: "worker_failure" });
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "getUserVersion",
        ]);
    });

    it("should finish an already-started Worker recovery before closing", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@close:example.org");
        const pending = manager.getUserVersion();
        const rejected = pending.catch((error: unknown) => error);
        fakeWorker.onerror?.(new Event("error"));
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });

        const close = manager.closeEventIndex();
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
        const recovery = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: recovery.id, reply: 3 } } as MessageEvent);
        await expect(rejected).resolves.toMatchObject({ code: "cancelled", retryability: "never" });
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        const closing = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: closing.id, reply: undefined } } as MessageEvent);
        await expect(close).resolves.toBeUndefined();
    });

    it("should recreate a closed binding before reinitializing the same account", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@close:example.org", "device");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await initializing;

        const closing = manager.closeEventIndex();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        const reopening = manager.initEventIndex("@close:example.org", "device");
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);

        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await closing;
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3));
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await expect(reopening).resolves.toBeUndefined();
        expect(manager.canUpgradeUserVersion(0, 1)).toBe(true);
    });

    it("should serialize a closed-binding reinit with a concurrent close", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@close:example.org");

        const closing = manager.closeEventIndex();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(2);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await closing;

        const reopening = manager.initEventIndex("@close:example.org", "device");
        const duplicateReopening = manager.initEventIndex("@close:example.org", "device");
        const closingAgain = manager.closeEventIndex();
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        const reinitRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; args: unknown[] };
        expect(reinitRequest.args).toEqual(["@close:example.org", "device"]);
        fakeWorker.onmessage?.({ data: { id: reinitRequest.id, reply: 3 } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await Promise.all([reopening, duplicateReopening, closingAgain]);
        expect(manager.canUpgradeUserVersion(0, 1)).toBe(false);
        expect(fakeWorker.terminate).toHaveBeenCalledOnce();
    });

    it("should stop account A recovery before reinitializing account B", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const accountAInit = manager.initEventIndex("@a:example.org", "device-a");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name?: string; args?: unknown[] };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountAInit;

        const accountAQuery = manager.queryFileEvents({
            roomId: "!a:example.org",
            category: "files",
            limit: 10,
            term: "private-a-term",
        });
        const staleResult = accountAQuery.catch((error: unknown) => error);
        fakeWorker.onerror?.(new Event("error"));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
        const recoveryRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as {
            name: string;
            args: unknown[];
        };
        expect(recoveryRequest).toMatchObject({ name: "initEventIndex", args: ["@a:example.org", "device-a"] });

        const accountBInit = manager.initEventIndex("@b:example.org", "device-b");
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await expect(staleResult).resolves.toMatchObject({ code: "cancelled", retryability: "never" });
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(5);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request.args).toEqual(["@b:example.org", "device-b"]);
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await accountBInit;
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "queryFileEvents",
            "initEventIndex",
            "closeEventIndex",
            "initEventIndex",
        ]);
    });

    it("should replace an uninitialized recovered Worker without calling close", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager, "@a:example.org");
        const pending = manager.getUserVersion();
        fakeWorker.onerror?.(new Event("error"));
        await vi.waitFor(() => {
            expect(fakeWorker.postMessage).toHaveBeenCalledTimes(3);
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("initEventIndex");
        });
        const recoveryRequest = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({
            data: {
                id: recoveryRequest.id,
                error: {
                    code: "storage_error",
                    operation: "initEventIndex",
                    retryability: "never",
                },
            },
        } as MessageEvent);
        await expect(pending).rejects.toMatchObject({ code: "storage_error" });

        const switching = manager.initEventIndex("@b:example.org", "device-b");
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4));
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request).toMatchObject({ name: "initEventIndex", args: ["@b:example.org", "device-b"] });
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await switching;
        expect(fakeWorker.postMessage.mock.calls.map(([payload]) => (payload as { name: string }).name)).toEqual([
            "initEventIndex",
            "getUserVersion",
            "initEventIndex",
            "initEventIndex",
        ]);
        expect(fakeWorker.terminate).toHaveBeenCalledTimes(3);
    });

    it("should accept error envelopes for every declared Worker operation", () => {
        expect(new Set(WEB_EVENT_INDEX_WORKER_OPERATIONS).size).toBe(WEB_EVENT_INDEX_WORKER_OPERATIONS.length);
        for (const operation of WEB_EVENT_INDEX_WORKER_OPERATIONS) {
            expect(
                WebEventIndexError.fromPayload({
                    code: "unknown",
                    operation,
                    retryability: "never",
                })?.operation,
            ).toBe(operation);
        }
    });

    it("should decode a safe structured Worker error without exposing its message", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager);
        const pending = manager.queryFileEvents({ roomId: "!room:id", category: "files", limit: 10, term: "secret" });
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({
            data: {
                id: request.id,
                error: {
                    code: "storage_error",
                    operation: "queryFileEvents",
                    retryability: "user_action",
                    message: "private query and storage detail",
                },
            },
        } as MessageEvent);
        await expect(pending).rejects.toMatchObject({
            code: "storage_error",
            operation: "queryFileEvents",
            retryability: "user_action",
            message: "The browser could not store local search data.",
        });
    });

    it("should treat legacy string and malformed Worker errors as unknown", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager);
        const pending = manager.searchEventIndex({
            search_term: "secret",
            limit: 10,
            room_id: "!room:id",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
        });
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, error: "private response detail" } } as MessageEvent);
        await expect(pending).rejects.toBeInstanceOf(WebEventIndexError);
        await expect(pending).rejects.toMatchObject({ code: "unknown", retryability: "never" });
    });

    it("should not reopen a closed account automatically after a Worker failure", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@closed:example.org", "device");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await initializing;

        const closing = manager.closeEventIndex();
        await vi.waitFor(() => {
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await closing;
        const requestsBeforeFailure = fakeWorker.postMessage.mock.calls.length;
        fakeWorker.onerror?.(new Event("error"));
        await expect(
            manager.searchEventIndex({
                search_term: "private",
                limit: 10,
                room_id: "!room:id",
                before_limit: 0,
                after_limit: 0,
                order_by_recency: true,
            }),
        ).rejects.toMatchObject({ code: "cancelled", retryability: "never" });
        expect(fakeWorker.postMessage).toHaveBeenCalledTimes(requestsBeforeFailure);
    });

    it("should send close and delete operations before closing the binding", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@terminal:example.org", "device");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await initializing;

        const closing = manager.closeEventIndex();
        await vi.waitFor(() => {
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("closeEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await closing;

        const deleting = manager.deleteEventIndex();
        await vi.waitFor(() => {
            expect((fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { name: string }).name).toBe("deleteEventIndex");
        });
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: undefined } } as MessageEvent);
        await deleting;
    });

    it("should recover the Worker when the same account is initialized after a failed close", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@same:example.org", "device");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await initializing;

        fakeWorker.onerror?.(new Event("error"));
        await expect(manager.closeEventIndex()).rejects.toMatchObject({ code: "worker_failure" });

        const previousRequestCount = fakeWorker.postMessage.mock.calls.length;
        const reopening = manager.initEventIndex("@same:example.org", "device");
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(previousRequestCount + 1));
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string; args: unknown[] };
        expect(request).toMatchObject({ name: "initEventIndex", args: ["@same:example.org", "device"] });
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await expect(reopening).resolves.toBeUndefined();
        expect(manager.canUpgradeUserVersion(0, 1)).toBe(true);
        expect(fakeWorker.terminate).toHaveBeenCalled();
    });

    it("should bind recovered schema capability to the replacement Worker", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        const initializing = manager.initEventIndex("@schema:example.org", "device");
        let request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await initializing;
        expect(manager.canUpgradeUserVersion(0, 1)).toBe(true);

        fakeWorker.onerror?.(new Event("error"));
        const requestsBeforeRecovery = fakeWorker.postMessage.mock.calls.length;
        const reinitializing = manager.initEventIndex("@schema:example.org", "device");
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(requestsBeforeRecovery + 1));
        request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await expect(reinitializing).resolves.toBeUndefined();
        expect(manager.canUpgradeUserVersion(0, 1)).toBe(true);
    });

    it("should recover concurrent pending requests after a fatal Worker error", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue(undefined);
        const manager = new WebEventIndexManager();
        await initManager(manager);
        const first = manager.searchEventIndex({
            search_term: "x",
            limit: 10,
            room_id: "!room:id",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: true,
        });
        const second = manager.loadFileEvents({ roomId: "!room:id", limit: 10 });
        fakeWorker.onerror?.(new Event("error"));

        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(4));
        const request = fakeWorker.postMessage.mock.calls.at(-1)?.[0] as { id: number; name: string };
        expect(request.name).toBe("initEventIndex");
        fakeWorker.onmessage?.({ data: { id: request.id, reply: 3 } } as MessageEvent);
        await vi.waitFor(() => expect(fakeWorker.postMessage).toHaveBeenCalledTimes(6));
        const replayed = fakeWorker.postMessage.mock.calls
            .slice(-2)
            .map(([payload]) => payload as { id: number; name: string });
        expect(replayed.map(({ name }) => name).sort()).toEqual(["loadFileEvents", "searchEventIndex"]);
        for (const item of replayed) {
            fakeWorker.onmessage?.({
                data: { id: item.id, reply: item.name === "loadFileEvents" ? [] : { events: [] } },
            } as MessageEvent);
        }
        await expect(first).resolves.toEqual({ events: [] });
        await expect(second).resolves.toEqual([]);
        expect(fakeWorker.terminate).toHaveBeenCalled();
    });
});
