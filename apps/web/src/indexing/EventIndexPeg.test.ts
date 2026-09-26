/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, type Mock, type Mocked } from "vitest";
import { mockPlatformPeg } from "test-utils";

import { EventIndexPeg } from "./EventIndexPeg.ts";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import SettingsStore from "../settings/SettingsStore.ts";
import { MatrixClientPeg } from "../MatrixClientPeg.ts";
import EventIndex from "./EventIndex.ts";

vi.mock("./EventIndex.ts");

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndexPeg", () => {
    describe("initEventIndex", () => {
        it("passes tokenizerMode to initEventIndex", async () => {
            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.initEventIndex).toHaveBeenCalledWith("@user:example.org", "DEVICE123", "ngram");
        });

        it("passes language tokenizer mode by default", async () => {
            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "language";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.initEventIndex).toHaveBeenCalledWith(
                "@user:example.org",
                "DEVICE123",
                "language",
            );
        });

        it("sets forceAddInitialCheckpoints when database was recreated", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });

            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue({ wasRecreated: true }),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndex.setForceAddInitialCheckpoints).toHaveBeenCalledWith(true);
        });

        it("sets forceAddInitialCheckpoints when index is empty", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });

            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(true),
                setUserVersion: vi.fn().mockResolvedValue(undefined),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.setUserVersion).toHaveBeenCalledWith(1);
            expect(mockIndex.setForceAddInitialCheckpoints).toHaveBeenCalledWith(true);
        });

        it("only updates a non-empty index version after the manager confirms a safe upgrade", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });

            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(0),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                canUpgradeUserVersion: vi.fn().mockReturnValue(true),
                closeEventIndex: vi.fn().mockResolvedValue(undefined),
                deleteEventIndex: vi.fn().mockResolvedValue(undefined),
                setUserVersion: vi.fn().mockResolvedValue(undefined),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.canUpgradeUserVersion).toHaveBeenCalledWith(0, 1);
            expect(mockIndexingManager.setUserVersion).toHaveBeenCalledWith(1);
            expect(mockIndexingManager.closeEventIndex).not.toHaveBeenCalled();
            expect(mockIndexingManager.deleteEventIndex).not.toHaveBeenCalled();
            expect(mockIndexingManager.initEventIndex).toHaveBeenCalledOnce();
        });

        it("should reject an unknown non-empty index version without deleting its data", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });
            const manager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(0),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                canUpgradeUserVersion: vi.fn().mockReturnValue(false),
                closeEventIndex: vi.fn().mockResolvedValue(undefined),
                deleteEventIndex: vi.fn().mockResolvedValue(undefined),
                setUserVersion: vi.fn().mockResolvedValue(undefined),
            } as unknown as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => manager });
            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);
            vi.spyOn(SettingsStore, "getValueAt").mockReturnValue("language" as any);

            const peg = new EventIndexPeg();
            expect(await peg.initEventIndex()).toBe(false);
            expect(manager.setUserVersion).not.toHaveBeenCalled();
            expect(manager.deleteEventIndex).not.toHaveBeenCalled();
            expect(manager.closeEventIndex).toHaveBeenCalledOnce();
            expect(manager.initEventIndex).toHaveBeenCalledOnce();
            expect(peg.get()).toBeNull();
            expect(peg.error).toMatchObject({ message: expect.stringContaining("data was kept") });
        });
    });
});
