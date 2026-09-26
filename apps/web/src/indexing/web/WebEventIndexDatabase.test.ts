/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebEventIndexDatabase } from "./WebEventIndexDatabase";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.restoreAllMocks());

describe("WebEventIndexDatabase", () => {
    it("should single-flight concurrent initialization for the same account", async () => {
        const database = new WebEventIndexDatabase();
        const open = vi.spyOn(indexedDB, "open");
        await expect(
            Promise.all([database.init("@same:example.org", "device"), database.init("@same:example.org", "device")]),
        ).resolves.toEqual([0, 0]);
        expect(open).toHaveBeenCalledOnce();
        expect(database.get().version).toBe(4);
        database.close();
    });

    it("should discard an older account open when another account initializes", async () => {
        const database = new WebEventIndexDatabase();
        const oldOpen = database.init("@old:example.org", "device");
        const currentOpen = database.init("@new:example.org", "device");
        await expect(oldOpen).rejects.toMatchObject({ code: "cancelled", operation: "initEventIndex" });
        await expect(currentOpen).resolves.toBe(0);
        expect(database.get().name).toContain("_40new_3Aexample.org");
        database.close();
    });

    it("should keep the newer account after an older open completes late", async () => {
        const seed = new WebEventIndexDatabase();
        await seed.init("@late-a:example.org", "device");
        const oldName = seed.get().name;
        seed.close();
        await seed.init("@late-b:example.org", "device");
        const newName = seed.get().name;
        seed.close();

        const nativeOpen = indexedDB.open.bind(indexedDB);
        const openExisting = (name: string): Promise<IDBDatabase> =>
            new Promise((resolve, reject) => {
                const request = nativeOpen(name);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        const oldConnection = await openExisting(oldName);
        const newConnection = await openExisting(newName);
        const makeRequest = (result: IDBDatabase): IDBOpenDBRequest =>
            ({
                result,
                error: null,
                transaction: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
            }) as unknown as IDBOpenDBRequest;
        const oldRequest = makeRequest(oldConnection);
        const newRequest = makeRequest(newConnection);
        const requests = new Map([
            [oldName, oldRequest],
            [newName, newRequest],
        ]);
        vi.spyOn(indexedDB, "open").mockImplementation((name) => requests.get(name)!);

        const database = new WebEventIndexDatabase();
        const oldOpen = database.init("@late-a:example.org", "device");
        const newOpen = database.init("@late-b:example.org", "device");
        newRequest.onsuccess?.(new Event("success"));
        await expect(newOpen).resolves.toBe(0);
        expect(database.get()).toBe(newConnection);

        oldRequest.onsuccess?.(new Event("success"));
        await expect(oldOpen).rejects.toMatchObject({ code: "cancelled", operation: "initEventIndex" });
        expect(database.get()).toBe(newConnection);
        database.close();
        oldConnection.close();
    });

    it("should allow a blocked explicit delete to finish before reopening the same account", async () => {
        const database = new WebEventIndexDatabase();
        await database.init("@delete:example.org", "device");
        const name = database.get().name;
        const oldConnection = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        await expect(database.delete()).rejects.toMatchObject({
            code: "connection_blocked",
            operation: "deleteEventIndex",
            retryability: "user_action",
        });
        await expect(database.init("@delete:example.org", "device")).rejects.toMatchObject({
            code: "connection_blocked",
        });

        oldConnection.close();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await expect(database.init("@delete:example.org", "device")).resolves.toBe(0);
        expect(database.get().version).toBe(4);
        database.close();
    });
});
