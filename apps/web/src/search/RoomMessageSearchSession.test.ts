/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixEvent, SearchResult, type ISearchResults, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { mockPlatformPeg } from "test-utils";

import { RoomMessageSearchSession } from "./RoomMessageSearchSession";
import { WebEventIndexError } from "../indexing/web/WebEventIndexError";
import { searchPagination, type ISeshatSearchResults } from "../Searching";
import EventIndexPeg from "../indexing/EventIndexPeg";
import { MatrixClientPeg } from "../MatrixClientPeg";
import type * as Searching from "../Searching";

vi.mock("../Searching", async () => ({
    ...(await vi.importActual<typeof Searching>("../Searching")),
    searchPagination: vi.fn(),
}));

function result(id: string, ts: number): SearchResult {
    const event = new MatrixEvent({
        event_id: id,
        room_id: "!room:id",
        origin_server_ts: ts,
        type: "m.room.message",
        sender: "@a:id",
        content: { msgtype: "m.text", body: id },
    });
    return { context: { getEvent: () => event } } as SearchResult;
}

const client = {} as MatrixClient;
beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
});
afterEach(() => vi.restoreAllMocks());

describe("RoomMessageSearchSession", () => {
    it("should retain same-timestamp results and consume the last history page before completion", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: true, scanned: 1, indexed: 1, canContinue: false }),
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const session = new RoomMessageSearchSession(client, "!room:id");
        const token = '{"key":["!room:id",10,"$b"],"exhausted":true}';
        const initial = {
            results: [result("$b", 10)],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults;
        session.acceptInitial(initial);
        vi.mocked(searchPagination).mockResolvedValue({
            ...initial,
            results: [result("$b", 10), result("$a", 10)],
            next_batch: '{"exhausted":true}',
        });
        expect(session.hasMore).toBe(true);
        const page = await session.loadMore(1);
        expect(page?.results.map((item) => item.context.getEvent().getId())).toEqual(["$a", "$b"]);
        expect(session.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledOnce();
    });

    it("should continue after an empty gap page when another captured gap has a match", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
            backfillRoom: vi
                .fn()
                .mockResolvedValueOnce({ exhausted: false, scanned: 0, indexed: 0, reason: "end", canContinue: true })
                .mockResolvedValueOnce({ exhausted: true, scanned: 1, indexed: 1, reason: "end", canContinue: false }),
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const token = '{"exhausted":true}';
        const initial = {
            results: [],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults;
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial(initial);
        vi.mocked(searchPagination)
            .mockResolvedValueOnce(initial)
            .mockResolvedValueOnce({ ...initial, results: [result("$later-gap", 1)] });
        await session.loadMore(1);
        expect(session.hasMore).toBe(true);
        const page = await session.loadMore(1);
        expect(page?.results.map((item) => item.context.getEvent().getId())).toEqual(["$later-gap"]);
        expect(index.backfillRoom).toHaveBeenCalledTimes(2);
    });

    it.each(["missing_token", "stalled"])(
        "should retain the last message batch after %s but reject retry",
        async (reason) => {
            mockPlatformPeg({
                getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
            });
            const index = {
                backfillRoom: vi.fn().mockResolvedValue({
                    exhausted: false,
                    scanned: 1,
                    indexed: 1,
                    canContinue: false,
                    reason,
                    error: new WebEventIndexError({
                        code: "network_failure",
                        operation: "backfill",
                        retryability: "retry",
                    }),
                }),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
            const token = '{"exhausted":true}';
            const session = new RoomMessageSearchSession(client, "!room:id");
            session.acceptInitial({
                results: [],
                highlights: [],
                next_batch: token,
                seshatQuery: { next_batch: token },
            } as ISearchResults);
            vi.mocked(searchPagination).mockResolvedValue({
                results: [result("$last", 1)],
                highlights: [],
                next_batch: token,
                seshatQuery: { next_batch: token },
            } as ISearchResults);
            expect((await session.loadMore(1))?.results.map((item) => item.context.getEvent().getId())).toEqual([
                "$last",
            ]);
            expect(session.needsHistoryRetry).toBe(true);
            expect(session.hasMore).toBe(false);
            expect(session.retryHistory()).toBe(false);
            await session.loadMore(1);
            expect(index.backfillRoom).toHaveBeenCalledOnce();
        },
    );

    it("should retry an explicitly recoverable backfill network error", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
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
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const token = '{"exhausted":true}';
        const initial = {
            results: [],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults;
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial(initial);
        vi.mocked(searchPagination).mockResolvedValue(initial);

        await expect(session.loadMore(1)).rejects.toMatchObject({ code: "network_failure" });
        expect(session.needsHistoryRetry).toBe(true);
        expect(session.hasMore).toBe(false);
        expect(session.retryHistory()).toBe(true);
        expect(session.hasMore).toBe(true);

        await session.loadMore(1);
        expect(index.backfillRoom).toHaveBeenCalledTimes(2);
        expect(session.hasMore).toBe(false);
    });

    it("should not retry a rejected backfill RPC without an owner outcome", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
            backfillRoom: vi.fn().mockRejectedValue(
                new WebEventIndexError({
                    code: "network_failure",
                    operation: "backfill",
                    retryability: "retry",
                }),
            ),
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const token = '{"exhausted":true}';
        const initial = {
            results: [],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults;
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial(initial);
        vi.mocked(searchPagination).mockResolvedValue(initial);

        await expect(session.loadMore(1)).rejects.toMatchObject({ code: "network_failure" });
        expect(session.hasMore).toBe(false);
        expect(session.retryHistory()).toBe(false);
        await session.loadMore(1);
        expect(index.backfillRoom).toHaveBeenCalledOnce();
    });

    it("should retry the pending local page without advancing room history twice", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: false, scanned: 1, indexed: 1, canContinue: true }),
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const token = '{"exhausted":true}';
        const initial = {
            results: [],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults;
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial(initial);
        vi.mocked(searchPagination)
            .mockRejectedValueOnce(new Error("provider query failed"))
            .mockResolvedValueOnce({ ...initial, results: [result("$indexed", 1)] });

        await expect(session.loadMore(1)).rejects.toThrow("provider query failed");
        expect(session.hasMore).toBe(true);
        expect(session.retryHistory()).toBe(false);
        await session.loadMore(1);
        expect(index.backfillRoom).toHaveBeenCalledOnce();
        expect(session.current?.results).toHaveLength(1);
        expect(session.hasMore).toBe(true);
    });

    it("should flag a 403 as limited accessible coverage rather than complete room history", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
            backfillRoom: vi.fn().mockResolvedValue({
                exhausted: false,
                scanned: 0,
                indexed: 0,
                canContinue: false,
                reason: "forbidden",
            }),
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const token = '{"exhausted":true}';
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({
            results: [],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults);
        vi.mocked(searchPagination).mockResolvedValue({
            results: [],
            highlights: [],
            next_batch: token,
            seshatQuery: { next_batch: token },
        } as ISearchResults);
        await session.loadMore(1);
        expect(session.isAccessLimited).toBe(true);
        expect(session.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledTimes(1);
    });

    it("should keep paging indexed results after history access is denied", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = {
            backfillRoom: vi.fn().mockResolvedValue({
                exhausted: false,
                scanned: 0,
                indexed: 0,
                canContinue: false,
                reason: "forbidden",
            }),
        };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const exhaustedToken = '{"exhausted":true}';
        const localToken = '{"exhausted":false}';
        const localQuery = {
            search_term: "",
            before_limit: 0,
            after_limit: 0,
            order_by_recency: false,
            limit: 10,
            next_batch: exhaustedToken,
        };
        const initial: ISeshatSearchResults = {
            results: [],
            highlights: [],
            next_batch: exhaustedToken,
            seshatQuery: localQuery,
        };
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial(initial);
        vi.mocked(searchPagination)
            .mockResolvedValueOnce({
                ...initial,
                results: [result("$indexed-1", 1)],
                next_batch: localToken,
                seshatQuery: { ...localQuery, next_batch: localToken },
            } as ISeshatSearchResults)
            .mockResolvedValueOnce({
                ...initial,
                results: [result("$indexed-1", 1), result("$indexed-2", 2)],
                next_batch: undefined,
            });

        await session.loadMore(1);
        expect(session.isAccessLimited).toBe(true);
        expect(session.hasMore).toBe(true);
        await session.loadMore(1);
        expect(session.current?.results).toHaveLength(2);
        expect(session.hasMore).toBe(false);
        expect(index.backfillRoom).toHaveBeenCalledOnce();
    });

    it("should treat server and Seshat cursors as opaque and not backfill through Web code", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => false }) as never,
        });
        const index = { backfillRoom: vi.fn() };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({ results: [], highlights: [], next_batch: '{"exhausted":true}' });
        expect(session.hasMore).toBe(true); // It is an opaque server token, not a Web cursor.
        vi.mocked(searchPagination).mockResolvedValue({ results: [], highlights: [] });
        await session.loadMore(1);
        expect(index.backfillRoom).not.toHaveBeenCalled();
        expect(session.hasMore).toBe(false);
    });

    it("should not send an old session's cursor or term to a new account index", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const oldIndex = { search: vi.fn() };
        const newIndex = { search: vi.fn() };
        const peg = vi.spyOn(EventIndexPeg, "get").mockReturnValue(oldIndex as never);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({
            results: [],
            highlights: [],
            next_batch: "opaque",
            seshatQuery: { search_term: "private term", next_batch: "opaque" },
        } as ISearchResults);
        peg.mockReturnValue(newIndex as never);
        await expect(session.loadMore(1)).rejects.toThrow("account changed");
        expect(searchPagination).not.toHaveBeenCalled();
        expect(newIndex.search).not.toHaveBeenCalled();
    });

    it("should preserve the server's exact total while deduplicating loaded pages", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => false }) as never,
        });
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        const session = new RoomMessageSearchSession(client, "!room:id");
        const first = Array.from({ length: 20 }, (_, i) => result(`$${i}`, i));
        session.acceptInitial({ results: first, highlights: [], next_batch: "server-cursor", count: 200 });
        vi.mocked(searchPagination).mockResolvedValue({
            results: [first[0], ...Array.from({ length: 20 }, (_, i) => result(`$${i + 20}`, i + 20))],
            highlights: [],
            count: 200,
        });
        const page = await session.loadMore(1);
        expect(page?.results).toHaveLength(40);
        expect(page?.count).toBe(200);
        expect(session.countIsExact).toBe(true);
    });

    it("should not merge a page returned after an account switch", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => false }) as never,
        });
        const oldIndex = { search: vi.fn() };
        const newIndex = { search: vi.fn() };
        const peg = vi.spyOn(EventIndexPeg, "get").mockReturnValue(oldIndex as never);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({ results: [], highlights: [], next_batch: "opaque" });
        const pending = Promise.withResolvers<ISearchResults>();
        vi.mocked(searchPagination).mockReturnValue(pending.promise);
        const load = session.loadMore(1);
        peg.mockReturnValue(newIndex as never);
        pending.resolve({ results: [result("$old", 1)], highlights: [] });
        await expect(load).rejects.toThrow("account changed");
        expect(session.current?.results).toEqual([]);
    });

    it("stops after the in-flight page and retries the same cursor on continuation", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => false }) as never,
        });
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({ results: [], highlights: [], next_batch: "opaque" });
        const pending = Promise.withResolvers<ISearchResults>();
        vi.mocked(searchPagination)
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce({
                results: [result("$next", 1)],
                highlights: [],
            });
        const published = vi.fn();
        const load = session.loadMore(10, undefined, true, published);
        session.stop();
        pending.resolve({ results: [result("$stale", 1)], highlights: [] });
        expect((await load)?.results).toEqual([]);
        expect(published).not.toHaveBeenCalled();
        expect(searchPagination).toHaveBeenCalledOnce();
        session.resume();
        expect((await session.loadMore(1))?.results.map((item) => item.context.getEvent().getId())).toEqual(["$next"]);
        expect(searchPagination).toHaveBeenCalledTimes(2);
    });

    it("publishes each committed page before a later page fails, retaining the first result", async () => {
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({ results: [], highlights: [], next_batch: "first" });
        const second = Promise.withResolvers<ISearchResults>();
        vi.mocked(searchPagination)
            .mockResolvedValueOnce({ results: [result("$first", 1)], highlights: [], next_batch: "second" })
            .mockReturnValueOnce(second.promise);
        const published: ISearchResults[] = [];
        const loading = session.loadMore(2, undefined, true, (page) => published.push(page));
        await vi.waitFor(() => expect(searchPagination).toHaveBeenCalledTimes(2));
        expect(published.map((page) => page.results.map((item) => item.context.getEvent().getId()))).toEqual([
            ["$first"],
        ]);
        second.reject(new Error("second page failed"));
        await expect(loading).rejects.toThrow("second page failed");
        expect(session.current?.results.map((item) => item.context.getEvent().getId())).toEqual(["$first"]);
    });

    it("never exposes server pagination as automatic local scrolling", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => false }) as never,
        });
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({ results: [], highlights: [], next_batch: "server-cursor" });
        expect(session.hasMoreLocal).toBe(false);
        expect(session.hasMore).toBe(true);
        expect(searchPagination).not.toHaveBeenCalled();
    });

    it("does not start automatic room-history backfill when local scan is exhausted", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => true }) as never,
        });
        const index = { backfillRoom: vi.fn() };
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(index as never);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({
            results: [],
            highlights: [],
            next_batch: '{"exhausted":true}',
            seshatQuery: { next_batch: '{"exhausted":true}' },
        } as ISearchResults);
        expect(session.hasMoreLocal).toBe(false);
        await session.loadMore(2, undefined, false);
        expect(index.backfillRoom).not.toHaveBeenCalled();
    });

    it("should discard a disposed session's delayed pagination result", async () => {
        mockPlatformPeg({
            getEventIndexingManager: () => ({ supportsLocalUnencryptedRoomSearch: () => false }) as never,
        });
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
        const session = new RoomMessageSearchSession(client, "!room:id");
        session.acceptInitial({ results: [], highlights: [], next_batch: "opaque" });
        const pending = Promise.withResolvers<ISearchResults>();
        vi.mocked(searchPagination).mockReturnValue(pending.promise);
        const published = vi.fn();
        const load = session.loadMore(1, undefined, true, published);
        session.dispose();
        pending.resolve({ results: [result("$stale", 1)], highlights: [] });
        expect(await load).toBeNull();
        expect(published).not.toHaveBeenCalled();
    });
});
