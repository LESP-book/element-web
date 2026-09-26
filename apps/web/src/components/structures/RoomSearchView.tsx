/*
Copyright 2024 New Vector Ltd.
Copyright 2015-2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type Ref, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
    type ISearchResults,
    type IThreadBundledRelationship,
    type MatrixEvent,
    type Room,
    THREAD_RELATION_TYPE,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { SearchIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import ChevronRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-right";
import { IconButton } from "@vector-im/compound-web";

import ScrollPanel from "./ScrollPanel";
import Spinner from "../views/elements/Spinner";
import AccessibleButton from "../views/elements/AccessibleButton";
import MemberAvatar from "../views/avatars/MemberAvatar";
import { _t } from "../../languageHandler";
import { haveRendererForEvent } from "../../events/EventTileFactory";
import eventSearch, { SearchScope } from "../../Searching";
import { RoomMessageSearchSession } from "../../search/RoomMessageSearchSession";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import SettingsStore from "../../settings/SettingsStore";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { useScopedRoomContext } from "../../contexts/ScopedRoomContext.tsx";
import { formatFullDateNoDayNoTime, formatTime } from "../../DateUtils";

const MANUAL_SHOW_MORE_PAGES = 2;
const AUTO_SHOW_MORE_PAGES = 2;

const TEXT_MESSAGE_TYPES = new Set(["m.text", "m.notice", "m.emote"]);
const SNIPPET_CONTEXT_BEFORE = 30;
const SNIPPET_CONTEXT_AFTER = 80;
const SNIPPET_FALLBACK_LENGTH = 120;

function getSearchableMessageBody(event: MatrixEvent): string | null {
    if (event.getType() !== "m.room.message") return null;
    const content = event.getContent();
    const msgtype = content?.msgtype;
    if (typeof msgtype !== "string" || !TEXT_MESSAGE_TYPES.has(msgtype)) return null;
    const body = content?.body;
    if (typeof body !== "string" || !body.trim()) return null;
    return body;
}

function buildSnippet(
    body: string,
    highlights: string[],
): { snippet: string; prefixEllipsis: boolean; suffixEllipsis: boolean } {
    const normalised = body.replace(/\s+/g, " ").trim();
    if (!normalised) return { snippet: "", prefixEllipsis: false, suffixEllipsis: false };

    const lower = normalised.toLowerCase();
    const terms = (highlights ?? [])
        .map((h) => h.trim())
        .filter(Boolean)
        .map((h) => h.toLowerCase());

    let matchIndex = -1;
    let matchLength = 0;
    for (const term of terms) {
        const idx = term ? lower.indexOf(term) : -1;
        if (idx === -1) continue;
        if (matchIndex === -1 || idx < matchIndex || (idx === matchIndex && term.length > matchLength)) {
            matchIndex = idx;
            matchLength = term.length;
        }
    }

    if (matchIndex === -1) {
        const snippet = normalised.slice(0, SNIPPET_FALLBACK_LENGTH);
        return {
            snippet,
            prefixEllipsis: false,
            suffixEllipsis: snippet.length < normalised.length,
        };
    }

    const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_BEFORE);
    const end = Math.min(normalised.length, matchIndex + matchLength + SNIPPET_CONTEXT_AFTER);
    const snippet = normalised.slice(start, end);
    return {
        snippet,
        prefixEllipsis: start > 0,
        suffixEllipsis: end < normalised.length,
    };
}

function renderHighlightedText(text: string, highlights: string[]): React.ReactNode {
    const terms = (highlights ?? []).map((h) => h.trim()).filter(Boolean);
    if (!terms.length || !text) return text;

    const textLower = text.toLowerCase();
    const termsLower = terms.map((t) => t.toLowerCase());

    const nodes: React.ReactNode[] = [];
    let pos = 0;
    while (pos < text.length) {
        let bestStart = -1;
        let bestEnd = -1;
        let bestTermLen = 0;

        for (let i = 0; i < termsLower.length; i++) {
            const term = termsLower[i];
            if (!term) continue;
            const idx = textLower.indexOf(term, pos);
            if (idx === -1) continue;
            const end = idx + term.length;
            if (bestStart === -1 || idx < bestStart || (idx === bestStart && term.length > bestTermLen)) {
                bestStart = idx;
                bestEnd = end;
                bestTermLen = term.length;
            }
        }

        if (bestStart === -1 || bestEnd === -1) {
            nodes.push(text.slice(pos));
            break;
        }

        if (bestStart > pos) {
            nodes.push(text.slice(pos, bestStart));
        }

        nodes.push(
            <span key={`hl-${bestStart}-${bestEnd}`} className="mx_EventTile_searchHighlight">
                {text.slice(bestStart, bestEnd)}
            </span>,
        );
        pos = bestEnd;
    }

    return nodes;
}

function jumpToEvent(roomId: string | undefined, eventId: string): void {
    dis.dispatch<ViewRoomPayload>({
        action: Action.ViewRoom,
        event_id: eventId,
        highlighted: true,
        room_id: roomId,
        metricsTrigger: undefined,
    });
}

function RoomSearchMessageResultItem({
    event,
    room,
    highlights,
}: {
    event: MatrixEvent;
    room: Room;
    highlights: string[];
}): JSX.Element | null {
    const eventId = event.getId();
    if (!eventId) return null;

    const senderId = event.getSender() ?? "";
    const member = room.getMember(senderId) ?? null;
    const body = getSearchableMessageBody(event);
    if (!body) return null;

    const { snippet, prefixEllipsis, suffixEllipsis } = buildSnippet(body, highlights);
    const isTwelveHour = Boolean(SettingsStore.getValue("showTwelveHourTimestamps"));
    const time = formatTime(new Date(event.getTs()), isTwelveHour);

    const onJumpToEvent = (ev: React.MouseEvent): void => {
        ev.preventDefault();
        ev.stopPropagation();
        jumpToEvent(event.getRoomId(), eventId);
    };

    return (
        <li data-scroll-tokens={eventId} className="mx_RoomSearchResultItem">
            <div className="mx_RoomSearchResultItem_time">{time}</div>
            <MemberAvatar
                className="mx_RoomSearchResultItem_avatar"
                member={member}
                fallbackUserId={senderId}
                size="32px"
                hideTitle
            />
            <div className="mx_RoomSearchResultItem_content">
                <div className="mx_RoomSearchResultItem_sender">{member?.name ?? senderId}</div>
                <div className="mx_RoomSearchResultItem_snippet">
                    {prefixEllipsis ? "…" : null}
                    {renderHighlightedText(snippet, highlights)}
                    {suffixEllipsis ? "…" : null}
                </div>
            </div>
            <IconButton
                className="mx_RoomSearchResultItem_jump"
                aria-label={_t("timeline|mab|view_in_room")}
                title={_t("timeline|mab|view_in_room")}
                onClick={onJumpToEvent}
            >
                <ChevronRightIcon />
            </IconButton>
        </li>
    );
}

interface Props {
    term: string;
    scope: SearchScope;
    inProgress: boolean;
    promise: Promise<ISearchResults>;
    className: string;
    onUpdate(
        this: void,
        inProgress: boolean,
        results: ISearchResults | null,
        error: Error | null,
        countIsExact?: boolean,
    ): void;
    ref?: Ref<ScrollPanel>;
}

// XXX: todo: merge overlapping results somehow?
// XXX: why doesn't searching on name work?
export const RoomSearchView = ({ term, scope, promise, className, onUpdate, inProgress, ref }: Props): JSX.Element => {
    const client = useContext(MatrixClientContext);
    const roomContext = useScopedRoomContext("showHiddenEvents", "room", "roomId");
    const roomId = roomContext.roomId;
    const [highlights, setHighlights] = useState<string[] | null>(null);
    const [results, setResults] = useState<ISearchResults | null>(null);
    const [error, setError] = useState(false);
    const sessionRef = useRef<RoomMessageSearchSession | null>(null);
    const ownerRef = useRef<{ current: RoomMessageSearchSession } | null>(null);
    const generation = useRef(0);
    const [isBackfilling, setIsBackfilling] = useState(false);
    const [isPaginating, setIsPaginating] = useState(false);
    const [stopped, setStopped] = useState(false);
    const isLoadingMore = useRef(false);

    const stopSearch = (): void => {
        generation.current++;
        sessionRef.current?.stop();
        setIsPaginating(false);
        setIsBackfilling(false);
        setStopped(true);
        onUpdate(false, sessionRef.current?.current ?? null, null);
    };

    const publishResults = useCallback(
        (page: ISearchResults, session: RoomMessageSearchSession, loading: boolean): void => {
            let highlights = page.highlights;
            if (!highlights.includes(term)) highlights = highlights.concat(term);
            highlights = highlights.sort((a, b) => b.length - a.length);

            for (const result of page.results) {
                for (const event of result.context.getTimeline()) {
                    const bundledRelationship = event.getServerAggregatedRelation<IThreadBundledRelationship>(
                        THREAD_RELATION_TYPE.name,
                    );
                    if (!bundledRelationship || event.getThread()) continue;
                    const room = client.getRoom(event.getRoomId());
                    const thread = room?.findThreadForEvent(event);
                    if (thread) event.setThread(thread);
                    else room?.createThread(event.getId()!, event, [], true);
                }
            }

            setHighlights(highlights);
            setResults({ ...page });
            const issue = session.needsHistoryRetry;
            setError(issue);
            onUpdate(
                loading,
                page,
                issue ? new Error(_t("room|search|history_cursor_failed")) : null,
                session.countIsExact,
            );
        },
        [client, term, onUpdate],
    );

    const handleSearchResult = useCallback(
        async (
            searchPromise: Promise<ISearchResults | null>,
            session: RoomMessageSearchSession,
            requestGeneration: number,
            initial = false,
        ): Promise<ISearchResults | null> => {
            const isCurrent = (): boolean =>
                generation.current === requestGeneration && sessionRef.current === session && !session.hasStopped;
            if (!isCurrent()) return null;
            onUpdate(true, session.current, null);
            setError(false);
            try {
                const results = await searchPromise;
                if (!isCurrent()) return null;
                if (!results || (initial && !session.acceptInitial(results))) {
                    throw new Error("Search results unavailable; please search again");
                }

                if (!isCurrent()) return null;
                publishResults(results, session, false);
                return results;
            } catch (error) {
                if (!isCurrent()) return null;
                if (error instanceof Error && error.name === "AbortError") {
                    setStopped(true);
                    onUpdate(false, session.current, null);
                } else {
                    logger.error("Search failed", error);
                    setError(true);
                    onUpdate(false, session.current, error as Error);
                }
                return null;
            }
        },
        [onUpdate, publishResults],
    );

    useEffect(() => {
        const session = new RoomMessageSearchSession(client, roomId ?? undefined);
        const requestGeneration = ++generation.current;
        const owner = { current: session };
        ownerRef.current = owner;
        sessionRef.current = session;
        void handleSearchResult(promise, session, requestGeneration, true);
        return () => {
            owner.current.dispose();
            ownerRef.current = null;
            sessionRef.current = null;
        };
    }, []); // oxlint-disable-line react-hooks/exhaustive-deps -- Parent keys this view by searchId.

    const loadMoreMessages = useCallback(
        async (pages: number, allowBackfill = true): Promise<boolean> => {
            const session = sessionRef.current!;
            if (!session.current || inProgress || isBackfilling || isLoadingMore.current) return false;
            const requestGeneration = generation.current;
            isLoadingMore.current = true;
            setIsPaginating(true);
            const previousCount = session.current.results.length;
            try {
                await handleSearchResult(
                    session.loadMore(
                        pages,
                        (running) => {
                            if (generation.current === requestGeneration && sessionRef.current === session)
                                setIsBackfilling(running);
                        },
                        allowBackfill,
                        (page) => {
                            if (generation.current === requestGeneration && sessionRef.current === session)
                                publishResults(page, session, true);
                        },
                    ),
                    session,
                    requestGeneration,
                );
                return (session.current?.results.length ?? 0) > previousCount;
            } finally {
                if (sessionRef.current === session) {
                    isLoadingMore.current = false;
                    if (generation.current === requestGeneration) setIsPaginating(false);
                }
            }
        },
        [inProgress, isBackfilling, handleSearchResult, publishResults],
    );

    const onSearchMore = useCallback(async (): Promise<void> => {
        await loadMoreMessages(MANUAL_SHOW_MORE_PAGES);
    }, [loadMoreMessages]);

    const onFillRequest = useCallback(
        async (backwards: boolean): Promise<boolean> => {
            if (backwards) return false;

            if (!sessionRef.current?.hasMoreLocal) return false;
            return loadMoreMessages(AUTO_SHOW_MORE_PAGES, false);
        },
        [loadMoreMessages],
    );

    const ret: JSX.Element[] = [];

    if (inProgress && results === null && !stopped) {
        ret.push(
            <li key="search-spinner">
                <Spinner />
            </li>,
        );
    }

    const onRef = (e: ScrollPanel | null): void => {
        if (typeof ref === "function") {
            ref(e);
        } else if (!!ref) {
            ref.current = e;
        }
    };

    if (results === null && !error && !stopped) {
        ret.push(
            <li key="search-loading">
                <div
                    className="mx_RoomView_messagePanel mx_RoomView_messagePanelSearchSpinner"
                    data-testid="messagePanelSearchSpinner"
                >
                    <SearchIcon />
                </div>
                <AccessibleButton kind="link_inline" onClick={stopSearch}>
                    {_t("file_panel|stop_search")}
                </AccessibleButton>
            </li>,
        );
    } else {
        const canShowMore = sessionRef.current?.hasMore ?? false;

        let lastRoomId: string | undefined;
        let lastGroupKey: string | undefined;
        const orderedResults = [...(results?.results ?? [])].sort((a, b) => {
            const tsDiff = b.context.getEvent().getTs() - a.context.getEvent().getTs();
            if (tsDiff !== 0) return tsDiff;
            const aId = a.context.getEvent().getId() ?? "";
            const bId = b.context.getEvent().getId() ?? "";
            return aId.localeCompare(bId);
        });

        for (const result of orderedResults) {
            const mxEv = result.context.getEvent();
            const resultRoomId = mxEv.getRoomId()!;
            const resultRoom = client.getRoom(resultRoomId);
            if (!resultRoom) {
                logger.log("Hiding search result from an unknown room", resultRoomId);
                continue;
            }

            if (!haveRendererForEvent(mxEv, client, roomContext.showHiddenEvents)) continue;

            if (scope === SearchScope.All) {
                if (resultRoomId !== lastRoomId) {
                    ret.push(
                        <li key={mxEv.getId() + "-room"}>
                            <h2>
                                {_t("common|room")}: {resultRoom.name}
                            </h2>
                        </li>,
                    );
                    lastRoomId = resultRoomId;
                    lastGroupKey = undefined;
                }
            }

            const body = getSearchableMessageBody(mxEv);
            if (!body) continue;

            const ts = mxEv.getTs();
            const date = new Date(ts);
            const groupKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
            if (groupKey !== lastGroupKey) {
                ret.push(
                    <li
                        key={`group-${resultRoomId}-${groupKey}-${mxEv.getId()}`}
                        className="mx_RoomSearchView_groupHeader"
                    >
                        <div className="mx_RoomSearchView_groupHeaderLabel">{formatFullDateNoDayNoTime(date)}</div>
                    </li>,
                );
                lastGroupKey = groupKey;
            }

            ret.push(
                <RoomSearchMessageResultItem
                    key={mxEv.getId()}
                    event={mxEv}
                    room={resultRoom}
                    highlights={highlights ?? []}
                />,
            );
        }

        if (!results?.results.length && !inProgress && !isBackfilling && !error && !stopped) {
            ret.push(
                <li key="search-empty">
                    <h2 className="mx_RoomView_topMarker">
                        {sessionRef.current?.isAccessLimited
                            ? _t("room|search|history_access_limited")
                            : canShowMore
                              ? _t("room|search|found_in_scanned_range")
                              : _t("common|no_results")}
                    </h2>
                </li>,
            );
        }

        if (isBackfilling) {
            ret.push(
                <li key="search-backfill">
                    <Spinner />
                </li>,
            );
        }

        // 分页加载更多时，顶部 spinner 用户在列表底部看不到，因此补一个靠近“显示更多”的加载提示。
        if (isPaginating && !isBackfilling) {
            ret.push(
                <li key="search-paginating">
                    <Spinner />
                </li>,
            );
        }

        if ((inProgress || isPaginating || isBackfilling || results === null) && !stopped && !error) {
            ret.push(
                <li key="search-stop">
                    <AccessibleButton kind="link_inline" onClick={stopSearch}>
                        {_t("file_panel|stop_search")}
                    </AccessibleButton>
                </li>,
            );
        }

        if (error) {
            ret.push(
                <li key="search-error" role="alert">
                    {!sessionRef.current?.isCurrentAccount
                        ? _t("room|search|index_changed")
                        : sessionRef.current?.needsHistoryRetry
                          ? _t("room|search|history_cursor_failed")
                          : _t("room|search|load_failed")}
                    {sessionRef.current?.isCurrentAccount ? (
                        <AccessibleButton
                            kind="link_inline"
                            onClick={() => {
                                sessionRef.current?.retryHistory();
                                const session = sessionRef.current;
                                if (!session) return;
                                const requestGeneration = generation.current;
                                void handleSearchResult(
                                    session.current
                                        ? session.loadMore(
                                              1,
                                              (running) => {
                                                  if (
                                                      generation.current === requestGeneration &&
                                                      sessionRef.current === session
                                                  )
                                                      setIsBackfilling(running);
                                              },
                                              true,
                                              (page) => {
                                                  if (
                                                      generation.current === requestGeneration &&
                                                      sessionRef.current === session
                                                  )
                                                      publishResults(page, session, true);
                                              },
                                          )
                                        : eventSearch(client, term, roomId ?? undefined),
                                    session,
                                    requestGeneration,
                                    !session.current,
                                );
                            }}
                        >
                            {_t("action|retry")}
                        </AccessibleButton>
                    ) : null}
                </li>,
            );
        }

        if (stopped) {
            ret.push(
                <li key="search-paused">
                    <AccessibleButton
                        kind="link_inline"
                        onClick={() => {
                            generation.current++;
                            setStopped(false);
                            let session = sessionRef.current;
                            if (session && isLoadingMore.current) {
                                // The old page may never settle. Restart the query rather than sharing its cursor.
                                session.dispose();
                                session = new RoomMessageSearchSession(client, roomId ?? undefined);
                                if (ownerRef.current) ownerRef.current.current = session;
                                sessionRef.current = session;
                                generation.current++;
                                isLoadingMore.current = false;
                                setIsPaginating(false);
                                setResults(null);
                                setHighlights(null);
                            }
                            if (session) {
                                session.resume();
                                const requestGeneration = generation.current;
                                void handleSearchResult(
                                    session.current
                                        ? session.loadMore(
                                              MANUAL_SHOW_MORE_PAGES,
                                              (running) => {
                                                  if (
                                                      generation.current === requestGeneration &&
                                                      sessionRef.current === session
                                                  )
                                                      setIsBackfilling(running);
                                              },
                                              true,
                                              (page) => {
                                                  if (
                                                      generation.current === requestGeneration &&
                                                      sessionRef.current === session
                                                  )
                                                      publishResults(page, session, true);
                                              },
                                          )
                                        : eventSearch(client, term, roomId ?? undefined),
                                    session,
                                    requestGeneration,
                                    !session.current,
                                );
                            }
                        }}
                    >
                        {_t("file_panel|continue_search")}
                    </AccessibleButton>
                </li>,
            );
        } else if (canShowMore && !error) {
            ret.push(
                <li key="search-more">
                    <AccessibleButton
                        kind="link_inline"
                        onClick={onSearchMore}
                        disabled={inProgress || isBackfilling || isPaginating}
                    >
                        {_t("common|show_more")}
                    </AccessibleButton>
                </li>,
            );
        } else if (!error && results?.results.length) {
            ret.push(
                <li key="search-no-more">
                    <h2 className="mx_RoomView_topMarker">
                        {sessionRef.current?.isAccessLimited
                            ? _t("room|search|history_access_limited")
                            : _t("no_more_results")}
                    </h2>
                </li>,
            );
        }
    }

    return (
        <ScrollPanel
            ref={onRef}
            className={"mx_RoomView_searchResultsPanel " + className}
            startAtBottom={false}
            stickyBottom={false}
            onFillRequest={onFillRequest}
        >
            <li className="mx_RoomView_scrollheader" />
            {ret}
        </ScrollPanel>
    );
};
