/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type IResultRoomEvents,
    type ISearchRequestBody,
    type ISearchResponse,
    type ISearchResult,
    type ISearchResults,
    SearchOrderBy,
    type IRoomEventFilter,
    EventType,
    type MatrixClient,
    type SearchResult,
} from "matrix-js-sdk/src/matrix";

import { type ISearchArgs } from "./indexing/BaseEventIndexManager";
import EventIndexPeg from "./indexing/EventIndexPeg";
import type EventIndex from "./indexing/EventIndex";
import { MatrixClientPeg } from "./MatrixClientPeg";
import PlatformPeg from "./PlatformPeg";
import { isNotUndefined } from "./Typeguards";

const SERVER_SEARCH_LIMIT = 10;
// FluffyChat 风格：本地搜索一次拉取更多结果，减少“显示更多”的点击次数。
const LOCAL_SEARCH_LIMIT = 30;
// combinedSearch/combinedPagination 使用的结果窗口大小：保持与服务端搜索分页一致。
const SEARCH_LIMIT = SERVER_SEARCH_LIMIT;

async function serverSideSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    const filter: IRoomEventFilter = {
        limit: SERVER_SEARCH_LIMIT,
    };

    if (roomId !== undefined) filter.rooms = [roomId];

    const body: ISearchRequestBody = {
        search_categories: {
            room_events: {
                search_term: term,
                filter: filter,
                order_by: SearchOrderBy.Recent,
                event_context: {
                    before_limit: 0,
                    after_limit: 0,
                    include_profile: true,
                },
            },
        },
    };

    const response = await client.search({ body: body }, abortSignal);

    return { response, query: body };
}

async function serverSideSearchProcess(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    const result = await serverSideSearch(client, term, roomId, abortSignal);

    // The js-sdk method backPaginateRoomEventsSearch() uses _query internally
    // so we're reusing the concept here since we want to delegate the
    // pagination back to backPaginateRoomEventsSearch() in some cases.
    const searchResults: ISearchResults = {
        abortSignal,
        _query: result.query,
        results: [],
        highlights: [],
    };

    return client.processRoomEventsSearch(searchResults, result.response);
}

function compareEvents(a: ISearchResult, b: ISearchResult): number {
    const aEvent = a.result;
    const bEvent = b.result;

    if (aEvent.origin_server_ts > bEvent.origin_server_ts) return -1;
    if (aEvent.origin_server_ts < bEvent.origin_server_ts) return 1;

    return 0;
}

export async function combinedSearch(
    client: MatrixClient,
    searchTerm: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    // Create two promises, one for the local search, one for the
    // server-side search.
    const serverSidePromise = serverSideSearch(client, searchTerm, undefined, abortSignal);
    const localPromise = localSearch(searchTerm);

    // Wait for both promises to resolve.
    await Promise.all([serverSidePromise, localPromise]);

    // Get both search results.
    const localResult = await localPromise;
    const serverSideResult = await serverSidePromise;

    const serverQuery = serverSideResult.query;
    const serverResponse = serverSideResult.response;

    const localQuery = localResult.query;
    const localResponse = localResult.response;

    // Store our queries for later on so we can support pagination.
    //
    // We're reusing _query here again to not introduce separate code paths and
    // concepts for our different pagination methods. We're storing the
    // server-side next batch separately since the query is the json body of
    // the request and next_batch needs to be a query parameter.
    //
    // We can't put it in the final result that _processRoomEventsSearch()
    // returns since that one can be either a server-side one, a local one or a
    // fake one to fetch the remaining cached events. See the docs for
    // combineEvents() for an explanation why we need to cache events.
    const emptyResult: ISeshatSearchResults = {
        seshatQuery: localQuery,
        _query: serverQuery,
        serverSideNextBatch: serverResponse.search_categories.room_events.next_batch,
        cachedEvents: [],
        oldestEventFrom: "server",
        results: [],
        highlights: [],
    };

    // Combine our results.
    const combinedResult = combineResponses(emptyResult, localResponse, serverResponse.search_categories.room_events);

    // Let the client process the combined result.
    const response: ISearchResponse = {
        search_categories: {
            room_events: combinedResult,
        },
    };

    const result = client.processRoomEventsSearch(emptyResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    restoreEncryptionInfo(result.results);

    return result;
}

async function localSearch(
    searchTerm: string,
    roomId?: string,
    eventIndex: EventIndex | null = EventIndexPeg.get(),
): Promise<{ response: IResultRoomEvents; query: ISearchArgs }> {
    if (!eventIndex || EventIndexPeg.get() !== eventIndex) throw new Error("Event index account changed");

    const searchArgs: ISearchArgs = {
        search_term: searchTerm,
        before_limit: 0,
        after_limit: 0,
        limit: LOCAL_SEARCH_LIMIT,
        order_by_recency: true,
        room_id: undefined,
    };

    if (roomId !== undefined) {
        searchArgs.room_id = roomId;
    }

    const localResult = await eventIndex.search(searchArgs);
    if (EventIndexPeg.get() !== eventIndex) throw new Error("Event index account changed");
    if (!localResult) {
        throw new Error("Local search failed");
    }

    normalizeLocalEvents(localResult);

    searchArgs.next_batch = localResult.next_batch;

    const result = {
        response: localResult,
        query: searchArgs,
    };

    return result;
}

// Apply the same normalization on the first and every subsequent local page.
function normalizeLocalEvents(localResult: IResultRoomEvents): void {
    // Seshat may return state_key: null for non-state events.
    if (localResult.results) {
        for (const searchResult of localResult.results) {
            const event = searchResult.result as unknown as Record<string, unknown>;
            if (event?.state_key === null) delete event.state_key;
            // Also fix context events
            if (searchResult.context) {
                for (const ctxEvent of searchResult.context.events_before || []) {
                    const ev = ctxEvent as unknown as Record<string, unknown>;
                    if (ev?.state_key === null) delete ev.state_key;
                }
                for (const ctxEvent of searchResult.context.events_after || []) {
                    const ev = ctxEvent as unknown as Record<string, unknown>;
                    if (ev?.state_key === null) delete ev.state_key;
                }
            }
        }
    }
}

export interface ISeshatSearchResults extends ISearchResults {
    seshatQuery?: ISearchArgs;
    cachedEvents?: ISearchResult[];
    oldestEventFrom?: "local" | "server";
    serverSideNextBatch?: string;
}

async function localSearchProcess(
    client: MatrixClient,
    searchTerm: string,
    roomId?: string,
    index: EventIndex | null = EventIndexPeg.get(),
): Promise<ISeshatSearchResults> {
    const emptyResult = {
        results: [],
        highlights: [],
    } as ISeshatSearchResults;

    if (searchTerm === "") return emptyResult;

    const result = await localSearch(searchTerm, roomId, index);

    emptyResult.seshatQuery = result.query;

    const response: ISearchResponse = {
        search_categories: {
            room_events: result.response,
        },
    };

    const processedResult = client.processRoomEventsSearch(emptyResult, response);
    // Restore our encryption info so we can properly re-verify the events.
    restoreEncryptionInfo(processedResult.results);

    return processedResult;
}

function cloneSeshatSearchResults(searchResult: ISeshatSearchResults): ISeshatSearchResults {
    return {
        ...searchResult,
        results: [...searchResult.results],
        highlights: [...searchResult.highlights],
        seshatQuery: searchResult.seshatQuery ? { ...searchResult.seshatQuery } : undefined,
        cachedEvents: searchResult.cachedEvents ? [...searchResult.cachedEvents] : undefined,
        pendingRequest: undefined,
    };
}

async function localPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
    eventIndex: EventIndex,
): Promise<ISeshatSearchResults> {
    if (!searchResult.seshatQuery) {
        throw new Error("localSearchProcess must be called first");
    }

    const workingResult = cloneSeshatSearchResults(searchResult);
    const query = workingResult.seshatQuery!;
    const localResult = await eventIndex.search(query);
    if (EventIndexPeg.get() !== eventIndex) throw new Error("Event index account changed");
    if (!localResult) {
        throw new Error("Local search pagination failed");
    }

    normalizeLocalEvents(localResult);

    // Commit the cursor only to a draft; a processing error leaves the caller's retry point intact.
    query.next_batch = localResult.next_batch;
    const newResultCount = localResult.results?.length ?? 0;
    const response = { search_categories: { room_events: localResult } };
    const result = client.processRoomEventsSearch(workingResult, response);
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);
    return result;
}

function compareOldestEvents(firstResults: ISearchResult[], secondResults: ISearchResult[]): number {
    try {
        const oldestFirstEvent = firstResults[firstResults.length - 1].result;
        const oldestSecondEvent = secondResults[secondResults.length - 1].result;

        if (oldestFirstEvent.origin_server_ts <= oldestSecondEvent.origin_server_ts) {
            return -1;
        } else {
            return 1;
        }
    } catch {
        return 0;
    }
}

function combineEventSources(
    previousSearchResult: ISeshatSearchResults,
    response: IResultRoomEvents,
    a: ISearchResult[],
    b: ISearchResult[],
): void {
    // Merge event sources and sort the events.
    const combinedEvents = a.concat(b).sort(compareEvents);
    // Put half of the events in the response, and cache the other half.
    response.results = combinedEvents.slice(0, SEARCH_LIMIT);
    previousSearchResult.cachedEvents = combinedEvents.slice(SEARCH_LIMIT);
}

/**
 * Combine the events from our event sources into a sorted result
 *
 * This method will first be called from the combinedSearch() method. In this
 * case we will fetch SEARCH_LIMIT events from the server and the local index.
 *
 * The method will put the SEARCH_LIMIT newest events from the server and the
 * local index in the results part of the response, the rest will be put in the
 * cachedEvents field of the previousSearchResult (in this case an empty search
 * result).
 *
 * Every subsequent call will be made from the combinedPagination() method, in
 * this case we will combine the cachedEvents and the next SEARCH_LIMIT events
 * from either the server or the local index.
 *
 * Since we have two event sources and we need to sort the results by date we
 * need keep on looking for the oldest event. We are implementing a variation of
 * a sliding window.
 *
 * The event sources are here represented as two sorted lists where the smallest
 * number represents the newest event. The two lists need to be merged in a way
 * that preserves the sorted property so they can be shown as one search result.
 * We first fetch SEARCH_LIMIT events from both sources.
 *
 * If we set SEARCH_LIMIT to 3:
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                |01, 02, 04|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                |03, 05, 09|
 *
 *  We note that the oldest event is from the local index, and we combine the
 *  results:
 *
 *  Server window [01, 02, 04]
 *  Local window  [03, 05, 09]
 *
 *  Combined events [01, 02, 03, 04, 05, 09]
 *
 *  We split the combined result in the part that we want to present and a part
 *  that will be cached.
 *
 *  Presented events [01, 02, 03]
 *  Cached events    [04, 05, 09]
 *
 *  We slide the window for the server since the oldest event is from the local
 *  index.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                            |06, 07, 08|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                |XX, XX, XX|
 *  Cached events [04, 05, 09]
 *
 *  We note that the oldest event is from the server and we combine the new
 *  server events with the cached ones.
 *
 *  Cached events [04, 05, 09]
 *  Server events [06, 07, 08]
 *
 *  Combined events [04, 05, 06, 07, 08, 09]
 *
 *  We split again.
 *
 *  Presented events [04, 05, 06]
 *  Cached events    [07, 08, 09]
 *
 *  We slide the local window, the oldest event is on the server.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                            |XX, XX, XX|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                            |10, 12, 14|
 *
 *  Cached events [07, 08, 09]
 *  Local events  [10, 12, 14]
 *  Combined events [07, 08, 09, 10, 12, 14]
 *
 *  Presented events [07, 08, 09]
 *  Cached events    [10, 12, 14]
 *
 *  Next up we slide the server window again.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                                        |11, 13|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                            |XX, XX, XX|
 *
 *  Cached events [10, 12, 14]
 *  Server events [11, 13]
 *  Combined events [10, 11, 12, 13, 14]
 *
 *  Presented events [10, 11, 12]
 *  Cached events    [13, 14]
 *
 *  We have one source exhausted, we fetch the rest of our events from the other
 *  source and combine it with our cached events.
 *
 *
 * @param {object} previousSearchResult A search result from a previous search
 * call.
 * @param {object} localEvents An unprocessed search result from the event
 * index.
 * @param {object} serverEvents An unprocessed search result from the server.
 *
 * @returns {object} A response object that combines the events from the
 * different event sources.
 *
 */
function combineEvents(
    previousSearchResult: ISeshatSearchResults,
    localEvents?: IResultRoomEvents,
    serverEvents?: IResultRoomEvents,
): IResultRoomEvents {
    const response = {} as IResultRoomEvents;

    const cachedEvents = previousSearchResult.cachedEvents ?? [];
    let oldestEventFrom = previousSearchResult.oldestEventFrom;
    response.highlights = previousSearchResult.highlights;

    if (localEvents && serverEvents && serverEvents.results) {
        // This is a first search call, combine the events from the server and
        // the local index. Note where our oldest event came from, we shall
        // fetch the next batch of events from the other source.
        if (compareOldestEvents(localEvents.results ?? [], serverEvents.results) < 0) {
            oldestEventFrom = "local";
        }

        combineEventSources(previousSearchResult, response, localEvents.results ?? [], serverEvents.results);
        response.highlights = (localEvents.highlights ?? []).concat(serverEvents.highlights ?? []);
    } else if (localEvents) {
        // This is a pagination call fetching more events from the local index,
        // meaning that our oldest event was on the server.
        // Change the source of the oldest event if our local event is older
        // than the cached one.
        if (compareOldestEvents(localEvents.results ?? [], cachedEvents) < 0) {
            oldestEventFrom = "local";
        }
        combineEventSources(previousSearchResult, response, localEvents.results ?? [], cachedEvents);
    } else if (serverEvents && serverEvents.results) {
        // This is a pagination call fetching more events from the server,
        // meaning that our oldest event was in the local index.
        // Change the source of the oldest event if our server event is older
        // than the cached one.
        if (compareOldestEvents(serverEvents.results, cachedEvents) < 0) {
            oldestEventFrom = "server";
        }
        combineEventSources(previousSearchResult, response, serverEvents.results, cachedEvents);
    } else {
        // This is a pagination call where we exhausted both of our event
        // sources, let's push the remaining cached events.
        response.results = cachedEvents;
        previousSearchResult.cachedEvents = [];
    }

    previousSearchResult.oldestEventFrom = oldestEventFrom;

    return response;
}

/**
 * Combine the local and server search responses
 *
 * @param {object} previousSearchResult A search result from a previous search
 * call.
 * @param {object} localEvents An unprocessed search result from the event
 * index.
 * @param {object} serverEvents An unprocessed search result from the server.
 *
 * @returns {object} A response object that combines the events from the
 * different event sources.
 */
function combineResponses(
    previousSearchResult: ISeshatSearchResults,
    localEvents?: IResultRoomEvents,
    serverEvents?: IResultRoomEvents,
): IResultRoomEvents {
    // Combine our events first.
    const response = combineEvents(previousSearchResult, localEvents, serverEvents);

    // Our first search will contain counts from both sources, subsequent
    // pagination requests will fetch responses only from one of the sources, so
    // reuse the first count when we're paginating.
    if (previousSearchResult.count) {
        response.count = previousSearchResult.count;
    } else {
        const localEventCount = localEvents?.count ?? 0;
        const serverEventCount = serverEvents?.count ?? 0;

        response.count = localEventCount + serverEventCount;
    }

    // Update our next batch tokens for the given search sources.
    if (localEvents && isNotUndefined(previousSearchResult.seshatQuery)) {
        previousSearchResult.seshatQuery.next_batch = localEvents.next_batch;
    }
    if (serverEvents) {
        previousSearchResult.serverSideNextBatch = serverEvents.next_batch;
    }

    // Set the response next batch token to one of the tokens from the sources,
    // this makes sure that if we exhaust one of the sources we continue with
    // the other one.
    if (previousSearchResult.seshatQuery?.next_batch) {
        response.next_batch = previousSearchResult.seshatQuery.next_batch;
    } else if (previousSearchResult.serverSideNextBatch) {
        response.next_batch = previousSearchResult.serverSideNextBatch;
    }

    // We collected all search results from the server as well as from Seshat,
    // we still have some events cached that we'll want to display on the next
    // pagination request.
    //
    // Provide a fake next batch token for that case.
    if (
        !response.next_batch &&
        isNotUndefined(previousSearchResult.cachedEvents) &&
        previousSearchResult.cachedEvents.length > 0
    ) {
        response.next_batch = "cached";
    }

    return response;
}

interface IEncryptedSeshatEvent {
    curve25519Key?: string;
    ed25519Key?: string;
    algorithm?: string;
    forwardingCurve25519KeyChain?: string[];
}

function restoreEncryptionInfo(searchResultSlice: SearchResult[] = []): void {
    for (const result of searchResultSlice) {
        const timeline = result.context.getTimeline();

        for (const mxEv of timeline) {
            const ev = mxEv.event as IEncryptedSeshatEvent;

            if (ev.curve25519Key) {
                mxEv.makeEncrypted(
                    EventType.RoomMessageEncrypted,
                    { algorithm: ev.algorithm },
                    ev.curve25519Key,
                    ev.ed25519Key!,
                );
                // @ts-ignore
                mxEv.forwardingCurve25519KeyChain = ev.forwardingCurve25519KeyChain;

                delete ev.curve25519Key;
                delete ev.ed25519Key;
                delete ev.algorithm;
                delete ev.forwardingCurve25519KeyChain;
            }
        }
    }
}

async function combinedPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
    eventIndex: EventIndex,
): Promise<ISeshatSearchResults> {
    const workingResult = cloneSeshatSearchResults(searchResult);
    const searchArgs = workingResult.seshatQuery;
    const oldestEventFrom = workingResult.oldestEventFrom;

    let localResult: IResultRoomEvents | undefined;
    let serverSideResult: ISearchResponse | undefined;

    if (searchArgs?.next_batch && (!workingResult.serverSideNextBatch || oldestEventFrom === "server")) {
        localResult = await eventIndex.search(searchArgs);
        if (EventIndexPeg.get() !== eventIndex) throw new Error("Event index account changed");
        if (localResult) normalizeLocalEvents(localResult);
    }

    if (workingResult.serverSideNextBatch && (oldestEventFrom === "local" || !searchArgs?.next_batch)) {
        const body = { body: workingResult._query!, next_batch: workingResult.serverSideNextBatch };
        serverSideResult = await client.search(body);
    }

    const serverEvents: IResultRoomEvents | undefined = serverSideResult?.search_categories.room_events;
    const combinedResult = combineResponses(workingResult, localResult, serverEvents);
    const response = { search_categories: { room_events: combinedResult } };
    const oldResultCount = workingResult.results.length;
    const result = client.processRoomEventsSearch(workingResult, response);
    const newResultCount = result.results.length - oldResultCount;
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);
    return result;
}

async function eventIndexSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    let searchPromise: Promise<ISearchResults>;
    const prefersLocalRoomSearch = Boolean(
        PlatformPeg.get()?.getEventIndexingManager()?.supportsLocalUnencryptedRoomSearch(),
    );
    const index = EventIndexPeg.get();

    if (roomId !== undefined) {
        // Web 端：所有房间统一走本地 IndexedDB，行为对齐 FluffyChat（不依赖 homeserver 的 /search）。
        if (prefersLocalRoomSearch) {
            searchPromise = index!
                .ensureRoomTimelineIndexed(roomId)
                .then(() => localSearchProcess(client, term, roomId, index));
        } else if (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) {
            // The search is for a single encrypted room, use our local
            // search method.
            searchPromise = localSearchProcess(client, term, roomId, index);
        } else {
            // The search is for a single non-encrypted room, use the
            // server-side search.
            searchPromise = serverSideSearchProcess(client, term, roomId, abortSignal);
        }
    } else {
        // Search across all rooms, use server-side search only.
        searchPromise = serverSideSearchProcess(client, term, roomId, abortSignal);
    }

    return searchPromise;
}

function trackPendingRequest<T extends ISearchResults>(searchResult: T, promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
        if (searchResult.pendingRequest === tracked) searchResult.pendingRequest = undefined;
    });
    searchResult.pendingRequest = tracked;
    return tracked;
}

function eventIndexSearchPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
    index: EventIndex,
): Promise<ISeshatSearchResults> {
    const seshatQuery = searchResult.seshatQuery;
    const serverQuery = searchResult._query;

    if (!seshatQuery) {
        // This is a search in a non-encrypted room. Do the normal server-side
        // pagination.
        return trackPendingRequest(searchResult, client.backPaginateRoomEventsSearch(searchResult));
    } else if (!serverQuery) {
        // This is a search in a encrypted room. Do a local pagination.
        return trackPendingRequest(searchResult, localPagination(client, searchResult, index));
    }

    // We have both queries around, this is a search across all rooms so a
    // combined pagination needs to be done.
    return trackPendingRequest(searchResult, combinedPagination(client, searchResult, index));
}

export function searchPagination(
    client: MatrixClient,
    searchResult: ISearchResults,
    expectedIndex?: EventIndex | null,
): Promise<ISearchResults> {
    const eventIndex = EventIndexPeg.get();
    if (expectedIndex !== undefined && (eventIndex !== expectedIndex || MatrixClientPeg.get() !== client)) {
        return Promise.reject(new Error("Event index account changed"));
    }
    if (searchResult.pendingRequest) return searchResult.pendingRequest;
    if (eventIndex === null) {
        return trackPendingRequest(searchResult, client.backPaginateRoomEventsSearch(searchResult));
    }
    return eventIndexSearchPagination(client, searchResult, eventIndex);
}

export default function eventSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    const eventIndex = EventIndexPeg.get();

    if (eventIndex === null) {
        // A homeserver cannot search decrypted content in an encrypted room.
        if (roomId && client.isRoomEncrypted(roomId)) {
            return Promise.reject(new Error("Local search index unavailable for encrypted room"));
        }
        return serverSideSearchProcess(client, term, roomId, abortSignal);
    } else {
        return eventIndexSearch(client, term, roomId, abortSignal);
    }
}

/**
 * The scope for a message search, either in the current room or across all rooms.
 */
export enum SearchScope {
    Room = "Room",
    All = "All",
}

/**
 * Information about a message search in progress.
 */
export interface SearchInfo {
    /**
     * Opaque ID for this search.
     */
    searchId: number;
    /**
     * The room ID being searched, or undefined if searching all rooms.
     */
    roomId?: string;
    /**
     * The search term.
     */
    term: string;
    /**
     * The scope of the search.
     */
    scope: SearchScope;
    /**
     * The promise for the search results.
     */
    promise: Promise<ISearchResults>;
    /**
     * Controller for aborting the search.
     */
    abortController?: AbortController;
    /**
     * Whether the search is currently awaiting data from the backend.
     */
    inProgress?: boolean;
    /**
     * The total count of matching results as returned by the backend.
     */
    count?: number;
    /** Whether count is a complete backend total rather than the currently found results. */
    countIsExact?: boolean;
    /**
     * Describe the error if any occured.
     */
    error?: Error;
}
