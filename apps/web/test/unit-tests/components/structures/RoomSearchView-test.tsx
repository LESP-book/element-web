/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { mocked } from "jest-mock";
import { fireEvent, render, screen, waitFor } from "jest-matrix-react";
import {
    Room,
    type MatrixClient,
    type IEvent,
    MatrixEvent,
    EventType,
    SearchResult,
    type ISearchResults,
} from "matrix-js-sdk/src/matrix";

import { RoomSearchView } from "../../../../src/components/structures/RoomSearchView";
import { clientAndSDKContextRenderOptions, stubClient } from "../../../test-utils";
import MatrixClientContext from "../../../../src/contexts/MatrixClientContext";
import { MatrixClientPeg } from "../../../../src/MatrixClientPeg";
import { searchPagination, SearchScope } from "../../../../src/Searching";
import { SDKContextClass } from "../../../../src/contexts/SDKContextClass";
import dis from "../../../../src/dispatcher/dispatcher";
import { Action } from "../../../../src/dispatcher/actions";

jest.mock("../../../../src/Searching", () => ({
    searchPagination: jest.fn(),
    SearchScope: jest.requireActual("../../../../src/Searching").SearchScope,
}));

describe("<RoomSearchView/>", () => {
    const eventMapper = (obj: Partial<IEvent>) => new MatrixEvent(obj);
    let client: MatrixClient;
    let sdkContext: SDKContextClass;
    let room: Room;

    beforeEach(async () => {
        stubClient();
        client = MatrixClientPeg.safeGet();
        sdkContext = new SDKContextClass();
        client.supportsThreads = jest.fn().mockReturnValue(true);
        room = new Room("!room:server", client, client.getSafeUserId());
        mocked(client.getRoom).mockReturnValue(room);

        jest.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
    });

    it("should show a spinner before the promise resolves", async () => {
        const deferred = Promise.withResolvers<ISearchResults>();

        render(
            <RoomSearchView
                inProgress={true}
                term="search term"
                scope={SearchScope.All}
                promise={deferred.promise}
                className="someClass"
                onUpdate={jest.fn()}
            />,
        );

        await screen.findByTestId("messagePanelSearchSpinner");
    });

    it("should render results when the promise resolves", async () => {
        render(
            <RoomSearchView
                inProgress={false}
                term="search term"
                scope={SearchScope.All}
                promise={Promise.resolve<ISearchResults>({
                    results: [
                        SearchResult.fromJson(
                            {
                                rank: 1,
                                result: {
                                    room_id: room.roomId,
                                    event_id: "$2",
                                    sender: client.getSafeUserId(),
                                    origin_server_ts: 1,
                                    content: { body: "Foo Test Bar", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                                context: {
                                    profile_info: {},
                                    events_before: [
                                        {
                                            room_id: room.roomId,
                                            event_id: "$1",
                                            sender: client.getSafeUserId(),
                                            origin_server_ts: 1,
                                            content: { body: "Before", msgtype: "m.text" },
                                            type: EventType.RoomMessage,
                                        },
                                    ],
                                    events_after: [
                                        {
                                            room_id: room.roomId,
                                            event_id: "$3",
                                            sender: client.getSafeUserId(),
                                            origin_server_ts: 1,
                                            content: { body: "After", msgtype: "m.text" },
                                            type: EventType.RoomMessage,
                                        },
                                    ],
                                },
                            },
                            eventMapper,
                        ),
                    ],
                    highlights: [],
                    count: 1,
                })}
                className="someClass"
                onUpdate={jest.fn()}
            />,
            clientAndSDKContextRenderOptions(client, sdkContext),
        );

        await screen.findByText("Foo Test Bar");
        expect(screen.getByText(/!room:server/)).toBeInTheDocument();
        expect(screen.getByText("1/1/1970")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "View in room" })).toBeInTheDocument();
        expect(screen.queryByText("Before")).not.toBeInTheDocument();
        expect(screen.queryByText("After")).not.toBeInTheDocument();
    });

    it("should highlight words correctly", async () => {
        render(
            <RoomSearchView
                inProgress={false}
                term="search term"
                scope={SearchScope.Room}
                promise={Promise.resolve<ISearchResults>({
                    results: [
                        SearchResult.fromJson(
                            {
                                rank: 1,
                                result: {
                                    room_id: room.roomId,
                                    event_id: "$2",
                                    sender: client.getSafeUserId(),
                                    origin_server_ts: 1,
                                    content: { body: "Foo Test Bar", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                                context: {
                                    profile_info: {},
                                    events_before: [],
                                    events_after: [],
                                },
                            },
                            eventMapper,
                        ),
                    ],
                    highlights: ["test"],
                    count: 1,
                })}
                className="someClass"
                onUpdate={jest.fn()}
            />,
            clientAndSDKContextRenderOptions(client, sdkContext),
        );

        const text = await screen.findByText("Test");
        expect(text).toHaveClass("mx_EventTile_searchHighlight");
    });

    it("should show spinner above results when backpaginating", async () => {
        const searchResults: ISearchResults = {
            results: [
                SearchResult.fromJson(
                    {
                        rank: 1,
                        result: {
                            room_id: room.roomId,
                            event_id: "$2",
                            sender: client.getSafeUserId(),
                            origin_server_ts: 1,
                            content: { body: "Foo Test Bar", msgtype: "m.text" },
                            type: EventType.RoomMessage,
                        },
                        context: {
                            profile_info: {},
                            events_before: [],
                            events_after: [],
                        },
                    },
                    eventMapper,
                ),
            ],
            highlights: ["test"],
            next_batch: "next_batch",
            count: 2,
        };

        mocked(searchPagination).mockResolvedValue({
            ...searchResults,
            results: [
                ...searchResults.results,
                SearchResult.fromJson(
                    {
                        rank: 1,
                        result: {
                            room_id: room.roomId,
                            event_id: "$4",
                            sender: client.getSafeUserId(),
                            origin_server_ts: 4,
                            content: { body: "Potato", msgtype: "m.text" },
                            type: EventType.RoomMessage,
                        },
                        context: {
                            profile_info: {},
                            events_before: [],
                            events_after: [],
                        },
                    },
                    eventMapper,
                ),
            ],
            next_batch: undefined,
        });
        const onUpdate = jest.fn();

        const { container, rerender } = render(
            <RoomSearchView
                inProgress={true}
                term="search term"
                scope={SearchScope.All}
                promise={Promise.resolve(searchResults)}
                className="someClass"
                onUpdate={onUpdate}
            />,
            clientAndSDKContextRenderOptions(client, sdkContext),
        );

        await screen.findByRole("progressbar");
        expect(container.querySelector(".mx_RoomSearchResultItem_snippet")).toHaveTextContent("Foo Test Bar");
        expect(onUpdate).toHaveBeenCalledWith(false, expect.objectContaining({}), null);
        expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-disabled", "true");

        rerender(
            <RoomSearchView
                inProgress={false}
                term="search term"
                scope={SearchScope.All}
                promise={Promise.resolve(searchResults)}
                className="someClass"
                onUpdate={jest.fn()}
            />,
        );

        const showMore = await screen.findByRole("button", { name: "Show more" });
        expect(showMore).not.toHaveAttribute("aria-disabled", "true");
        fireEvent.click(showMore);
        await screen.findByText("Potato");
        expect(searchPagination).toHaveBeenCalledWith(client, expect.objectContaining({ next_batch: "next_batch" }));
        await waitFor(() => {
            expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        });
    });

    it("should handle resolutions after unmounting sanely", async () => {
        const deferred = Promise.withResolvers<ISearchResults>();

        const { unmount } = render(
            <MatrixClientContext.Provider value={client}>
                <RoomSearchView
                    inProgress={false}
                    term="search term"
                    scope={SearchScope.All}
                    promise={deferred.promise}
                    className="someClass"
                    onUpdate={jest.fn()}
                />
            </MatrixClientContext.Provider>,
        );

        unmount();
        deferred.resolve({
            results: [],
            highlights: [],
        });
    });

    it("should handle rejections after unmounting sanely", async () => {
        const deferred = Promise.withResolvers<ISearchResults>();

        const { unmount } = render(
            <MatrixClientContext.Provider value={client}>
                <RoomSearchView
                    inProgress={false}
                    term="search term"
                    scope={SearchScope.All}
                    promise={deferred.promise}
                    className="someClass"
                    onUpdate={jest.fn()}
                />
            </MatrixClientContext.Provider>,
        );

        unmount();
        deferred.reject({
            results: [],
            highlights: [],
        });
    });

    it("report error if one is encountered", async () => {
        const onUpdate = jest.fn();
        const deferred = Promise.withResolvers<ISearchResults>();

        render(
            <MatrixClientContext.Provider value={client}>
                <RoomSearchView
                    inProgress={false}
                    term="search term"
                    scope={SearchScope.All}
                    promise={deferred.promise}
                    className="someClass"
                    onUpdate={onUpdate}
                />
            </MatrixClientContext.Provider>,
        );
        deferred.reject("Some error");
        try {
            // Wait for RoomSearchView to process the promise
            await deferred.promise;
        } catch {}

        expect(onUpdate).toHaveBeenCalledWith(false, null, "Some error");
        expect(onUpdate).toHaveBeenCalledTimes(2);
    });

    it("should combine search results when the query is present in multiple sucessive messages", async () => {
        const searchResults: ISearchResults = {
            results: [
                SearchResult.fromJson(
                    {
                        rank: 1,
                        result: {
                            room_id: room.roomId,
                            event_id: "$4",
                            sender: client.getUserId() ?? "",
                            origin_server_ts: 1,
                            content: { body: "Foo2", msgtype: "m.text" },
                            type: EventType.RoomMessage,
                        },
                        context: {
                            profile_info: {},
                            events_before: [
                                {
                                    room_id: room.roomId,
                                    event_id: "$3",
                                    sender: client.getUserId() ?? "",
                                    origin_server_ts: 1,
                                    content: { body: "Between", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                            ],
                            events_after: [
                                {
                                    room_id: room.roomId,
                                    event_id: "$5",
                                    sender: client.getUserId() ?? "",
                                    origin_server_ts: 1,
                                    content: { body: "After", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                            ],
                        },
                    },
                    eventMapper,
                ),
                SearchResult.fromJson(
                    {
                        rank: 1,
                        result: {
                            room_id: room.roomId,
                            event_id: "$2",
                            sender: client.getUserId() ?? "",
                            origin_server_ts: 1,
                            content: { body: "Foo", msgtype: "m.text" },
                            type: EventType.RoomMessage,
                        },
                        context: {
                            profile_info: {},
                            events_before: [
                                {
                                    room_id: room.roomId,
                                    event_id: "$1",
                                    sender: client.getUserId() ?? "",
                                    origin_server_ts: 1,
                                    content: { body: "Before", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                            ],
                            events_after: [
                                {
                                    room_id: room.roomId,
                                    event_id: "$3",
                                    sender: client.getUserId() ?? "",
                                    origin_server_ts: 1,
                                    content: { body: "Between", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                            ],
                        },
                    },
                    eventMapper,
                ),
            ],
            highlights: [],
            next_batch: "",
            count: 1,
        };

        const { container } = render(
            <RoomSearchView
                inProgress={false}
                term="search term"
                scope={SearchScope.All}
                promise={Promise.resolve(searchResults)}
                className="someClass"
                onUpdate={jest.fn()}
            />,
            clientAndSDKContextRenderOptions(client, sdkContext),
        );

        expect(await screen.findByText("Foo", { exact: true })).toBeInTheDocument();
        expect(await screen.findByText("Foo2", { exact: true })).toBeInTheDocument();
        expect(container.querySelectorAll(".mx_RoomSearchResultItem")).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: "View in room" })).toHaveLength(2);
        expect(screen.queryByText("Before")).not.toBeInTheDocument();
        expect(screen.queryByText("Between")).not.toBeInTheDocument();
        expect(screen.queryByText("After")).not.toBeInTheDocument();
    });

    it("should group all-room results and expose jump actions", async () => {
        const room2 = new Room("!room2:server", client, client.getSafeUserId());
        const room3 = new Room("!room3:server", client, client.getSafeUserId());
        mocked(client.getRoom).mockImplementation(
            (roomId) => [room, room2, room3].find((r) => r.roomId === roomId) ?? null,
        );

        const { container } = render(
            <RoomSearchView
                inProgress={false}
                term="search term"
                scope={SearchScope.All}
                promise={Promise.resolve<ISearchResults>({
                    results: [
                        SearchResult.fromJson(
                            {
                                rank: 1,
                                result: {
                                    room_id: room.roomId,
                                    event_id: "$2",
                                    sender: client.getSafeUserId(),
                                    origin_server_ts: 1,
                                    content: { body: "Room 1", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                                context: {
                                    profile_info: {},
                                    events_before: [],
                                    events_after: [],
                                },
                            },
                            eventMapper,
                        ),
                        SearchResult.fromJson(
                            {
                                rank: 2,
                                result: {
                                    room_id: room2.roomId,
                                    event_id: "$22",
                                    sender: client.getSafeUserId(),
                                    origin_server_ts: 1,
                                    content: { body: "Room 2", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                                context: {
                                    profile_info: {},
                                    events_before: [],
                                    events_after: [],
                                },
                            },
                            eventMapper,
                        ),
                        SearchResult.fromJson(
                            {
                                rank: 2,
                                result: {
                                    room_id: room2.roomId,
                                    event_id: "$23",
                                    sender: client.getSafeUserId(),
                                    origin_server_ts: 2,
                                    content: { body: "Room 2 message 2", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                                context: {
                                    profile_info: {},
                                    events_before: [],
                                    events_after: [],
                                },
                            },
                            eventMapper,
                        ),
                        SearchResult.fromJson(
                            {
                                rank: 3,
                                result: {
                                    room_id: room3.roomId,
                                    event_id: "$32",
                                    sender: client.getSafeUserId(),
                                    origin_server_ts: 1,
                                    content: { body: "Room 3", msgtype: "m.text" },
                                    type: EventType.RoomMessage,
                                },
                                context: {
                                    profile_info: {},
                                    events_before: [],
                                    events_after: [],
                                },
                            },
                            eventMapper,
                        ),
                    ],
                    highlights: [],
                    count: 1,
                })}
                className="someClass"
                onUpdate={jest.fn()}
            />,
            clientAndSDKContextRenderOptions(client, sdkContext),
        );

        await screen.findByText("Room 1");
        await screen.findByText("Room 2");
        await screen.findByText("Room 2 message 2");
        await screen.findByText("Room 3");

        const resultItems = Array.from(container.querySelectorAll<HTMLElement>(".mx_RoomSearchResultItem"));
        expect(resultItems).toHaveLength(4);
        expect(new Set(resultItems.map((item) => item.dataset.scrollTokens))).toEqual(
            new Set(["$2", "$22", "$23", "$32"]),
        );
        expect(resultItems.every((item) => item.querySelector(".mx_RoomSearchResultItem_jump"))).toBe(true);

        const dispatchSpy = jest.spyOn(dis, "dispatch");
        const roomOneResult = container.querySelector<HTMLElement>('li[data-scroll-tokens="$2"]');
        fireEvent.click(roomOneResult!.querySelector(".mx_RoomSearchResultItem_jump")!);
        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.ViewRoom,
                event_id: "$2",
                highlighted: true,
                room_id: room.roomId,
            }),
        );
        dispatchSpy.mockRestore();
    });
});
