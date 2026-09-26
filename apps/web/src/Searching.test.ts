/*
Copyright 2025 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { type IResultRoomEvents, type ISearchResults } from "matrix-js-sdk/src/matrix";
import { createTestClient, mockPlatformPeg } from "test-utils";

import eventSearch, { searchPagination, type ISeshatSearchResults } from "./Searching";
import EventIndexPeg from "./indexing/EventIndexPeg";

describe("Searching", () => {
    const mockClient = createTestClient();
    const backPaginateRoomEventsSearch = vi.fn();
    Object.defineProperty(mockClient, "backPaginateRoomEventsSearch", {
        configurable: true,
        value: backPaginateRoomEventsSearch,
    });

    beforeEach(() => {
        vi.clearAllMocks();
        backPaginateRoomEventsSearch.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should route a plaintext room to the Web index by capability, not platform name", async () => {
        const index = {
            ensureRoomTimelineIndexed: vi.fn().mockResolvedValue(undefined),
            search: vi.fn().mockResolvedValue({ results: [], highlights: [], next_batch: '{"exhausted":true}' }),
        };
        mockPlatformPeg({
            getHumanReadableName: () => "Renamed web build",
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        vi.spyOn(mockClient, "getCrypto").mockReturnValue({
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(false),
        } as never);
        await eventSearch(mockClient, "needle", "!room:id");
        expect(index.ensureRoomTimelineIndexed).toHaveBeenCalledWith("!room:id");
        expect(index.search).toHaveBeenCalledOnce();
    });

    it("should not send encrypted room terms to server search when the index is unavailable", async () => {
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        vi.spyOn(mockClient, "isRoomEncrypted").mockReturnValue(true);
        const server = vi.spyOn(mockClient, "search");
        await expect(eventSearch(mockClient, "secret", "!room:id")).rejects.toThrow("index unavailable");
        expect(server).not.toHaveBeenCalled();
    });

    it("should release a rejected server pagination request so a later call can retry", async () => {
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        const result = {
            results: [],
            highlights: [],
            next_batch: "server-cursor",
            _query: { search_categories: { room_events: { search_term: "needle" } } },
        } as unknown as ISearchResults;
        backPaginateRoomEventsSearch.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(result);

        await expect(searchPagination(mockClient, result)).rejects.toThrow("offline");
        expect(result.pendingRequest).toBeUndefined();
        await expect(searchPagination(mockClient, result)).resolves.toMatchObject({ results: [] });
        expect(backPaginateRoomEventsSearch).toHaveBeenCalledTimes(2);
        expect(result.pendingRequest).toBeUndefined();
    });

    it("should retry local message pagination after a rejected page without advancing its cursor", async () => {
        const index = {
            search: vi
                .fn()
                .mockRejectedValueOnce(new Error("storage failure"))
                .mockResolvedValueOnce({ results: [], highlights: [], next_batch: "next" }),
        };
        vi.spyOn(mockClient, "processRoomEventsSearch").mockImplementation((draft, response) => {
            draft.next_batch = response.search_categories.room_events.next_batch;
            return draft;
        });
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const result = {
            results: [],
            highlights: [],
            seshatQuery: {
                search_term: "needle",
                next_batch: "current",
                before_limit: 0,
                after_limit: 0,
                order_by_recency: true,
                limit: 10,
            },
        } as ISeshatSearchResults;

        await expect(searchPagination(mockClient, result)).rejects.toThrow("storage failure");
        expect(result.pendingRequest).toBeUndefined();
        expect(result.seshatQuery?.next_batch).toBe("current");
        const next = await searchPagination(mockClient, result);
        expect(index.search).toHaveBeenCalledTimes(2);
        expect(next.next_batch).toBe("next");
        expect(result.seshatQuery?.next_batch).toBe("current");
    });

    describe("localSearch", () => {
        it("removes state_key: null from search results", async () => {
            // Mock search results from Seshat that include state_key: null
            const mockSearchResults: IResultRoomEvents = {
                count: 2,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$event1",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567890,
                            content: { body: "test message 1", msgtype: "m.text" },
                            // Seshat incorrectly includes state_key: null for non-state events
                            state_key: null,
                        } as any,
                        context: {
                            events_before: [
                                {
                                    event_id: "$before1",
                                    room_id: "!room:example.org",
                                    sender: "@user:example.org",
                                    type: "m.room.message",
                                    origin_server_ts: 1234567889,
                                    content: { body: "before message", msgtype: "m.text" },
                                    state_key: null,
                                } as any,
                            ],
                            events_after: [
                                {
                                    event_id: "$after1",
                                    room_id: "!room:example.org",
                                    sender: "@user:example.org",
                                    type: "m.room.message",
                                    origin_server_ts: 1234567891,
                                    content: { body: "after message", msgtype: "m.text" },
                                    state_key: null,
                                } as any,
                            ],
                            profile_info: {},
                        },
                    },
                    {
                        rank: 2,
                        result: {
                            event_id: "$event2",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567880,
                            content: { body: "test message 2", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: {
                            events_before: [],
                            events_after: [],
                            profile_info: {},
                        },
                    },
                ],
                highlights: ["test"],
            };

            // Mock EventIndex.search to return results with state_key: null
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue(mockSearchResults),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            // Mock crypto to indicate room is encrypted
            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
            } as any);

            // Perform search in an encrypted room
            const roomId = "!room:example.org";
            await eventSearch(mockClient, "test", roomId);

            // Verify that state_key: null was removed from the search arguments passed to search
            expect(mockEventIndex.search).toHaveBeenCalled();

            // Get the mock search results that were passed to processRoomEventsSearch
            // The state_key should have been deleted from the original results object
            const mainEventResult = mockSearchResults.results![0].result as unknown as Record<string, unknown>;
            expect(mainEventResult.state_key).toBeUndefined();

            const beforeEvent = mockSearchResults.results![0].context!.events_before![0] as unknown as Record<
                string,
                unknown
            >;
            expect(beforeEvent.state_key).toBeUndefined();

            const afterEvent = mockSearchResults.results![0].context!.events_after![0] as unknown as Record<
                string,
                unknown
            >;
            expect(afterEvent.state_key).toBeUndefined();

            const secondResult = mockSearchResults.results![1].result as unknown as Record<string, unknown>;
            expect(secondResult.state_key).toBeUndefined();
        });

        it("does not modify events without state_key: null", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 1,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$event1",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567890,
                            content: { body: "test message", msgtype: "m.text" },
                            // No state_key property at all (correct behavior)
                        } as any,
                        context: {
                            events_before: [],
                            events_after: [],
                            profile_info: {},
                        },
                    },
                ],
                highlights: ["test"],
            };

            const mockEventIndex = {
                search: vi.fn().mockResolvedValue(mockSearchResults),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
            } as any);

            const roomId = "!room:example.org";
            await eventSearch(mockClient, "test", roomId);

            // Verify state_key is still undefined (not accidentally set to something)
            const eventResult = mockSearchResults.results![0].result as unknown as Record<string, unknown>;
            expect("state_key" in eventResult).toBe(false);
        });

        it("handles missing context fields and empty result sets", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 3,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$event1",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567890,
                            content: { body: "test message", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: {
                            events_before: [{ event_id: "$before1", state_key: "not-null" } as any],
                            events_after: [{ event_id: "$after1", state_key: "not-null" } as any],
                            profile_info: {},
                        },
                    },
                    {
                        rank: 2,
                        result: {
                            event_id: "$event2",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567891,
                            content: { body: "test message 2", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: {
                            profile_info: {},
                        } as any,
                    },
                    {
                        rank: 3,
                        result: {
                            event_id: "$event3",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567892,
                            content: { body: "test message 3", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: undefined as any,
                    },
                ],
                highlights: ["test"],
            };

            const mockEventIndex = {
                search: vi
                    .fn()
                    .mockResolvedValueOnce(mockSearchResults)
                    .mockResolvedValueOnce({ count: 0, highlights: ["test"] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
            } as any);

            const roomId = "!room:example.org";
            await eventSearch(mockClient, "test", roomId);
            await eventSearch(mockClient, "test", roomId);

            const firstMainEvent = mockSearchResults.results![0].result as unknown as Record<string, unknown>;
            expect(firstMainEvent.state_key).toBeUndefined();

            const beforeEvent = mockSearchResults.results![0].context!.events_before![0] as unknown as Record<
                string,
                unknown
            >;
            expect(beforeEvent.state_key).toBe("not-null");

            const afterEvent = mockSearchResults.results![0].context!.events_after![0] as unknown as Record<
                string,
                unknown
            >;
            expect(afterEvent.state_key).toBe("not-null");

            const secondMainEvent = mockSearchResults.results![1].result as unknown as Record<string, unknown>;
            expect(secondMainEvent.state_key).toBeUndefined();

            const thirdMainEvent = mockSearchResults.results![2].result as unknown as Record<string, unknown>;
            expect(thirdMainEvent.state_key).toBeUndefined();
        });
    });
});
