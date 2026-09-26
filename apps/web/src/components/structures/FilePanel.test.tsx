/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import { MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { act, fireEvent, screen, render, waitFor } from "test-utils-rtl";
import { clientAndSDKContextRenderOptions, mkEvent, stubClient } from "test-utils";

import FilePanel from "./FilePanel";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { SDKContextClass } from "../../contexts/SDKContextClass.ts";
import EventIndexPeg from "../../indexing/EventIndexPeg.ts";
import { WebEventIndexError } from "../../indexing/web/WebEventIndexError";
import { RoomFileSearchSession } from "../../search/RoomFileSearchSession";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

describe("FilePanel", () => {
    beforeEach(() => {
        stubClient();
        vi.spyOn(EventIndexPeg, "get").mockReturnValue({
            loadFileEvents: vi.fn().mockResolvedValue([]),
            backfillRoom: vi.fn().mockResolvedValue({ exhausted: true, scanned: 0, indexed: 0, canContinue: false }),
            crawlingRooms: vi.fn().mockReturnValue({ crawlingRooms: new Set(), totalRooms: new Set() }),
            on: vi.fn(),
            removeListener: vi.fn(),
        } as unknown as NonNullable<ReturnType<typeof EventIndexPeg.get>>);
    });

    afterEach(() => vi.restoreAllMocks());

    it("renders empty state", async () => {
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);

        const { asFragment } = render(
            <FilePanel roomId={room.roomId} onClose={vi.fn()} />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        await waitFor(() => {
            expect(screen.getByText("No files visible in this room")).toBeInTheDocument();
        });
        expect(screen.getByPlaceholderText("Search by file name…")).toBeInTheDocument();
        expect(screen.getByTestId("filter-tab-file-panel-media")).toBeInTheDocument();
        expect(screen.getByTestId("filter-tab-file-panel-files").querySelector("input")).toBeChecked();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("No more indexed files");
        expect(screen.getByText("Filters").closest("details")).not.toHaveAttribute("open");
        expect(asFragment()).toMatchSnapshot();
    });

    it("should announce the initial search while its local index request is pending", async () => {
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);
        const pending = Promise.withResolvers<MatrixEvent[]>();
        vi.mocked(EventIndexPeg.get).mockReturnValue({
            loadFileEvents: vi.fn().mockReturnValue(pending.promise),
            crawlingRooms: vi.fn().mockReturnValue({ crawlingRooms: new Set(), totalRooms: new Set() }),
            on: vi.fn(),
            removeListener: vi.fn(),
        } as unknown as NonNullable<ReturnType<typeof EventIndexPeg.get>>);
        const { unmount } = render(
            <FilePanel roomId={room.roomId} onClose={vi.fn()} />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        expect(screen.getByRole("status")).toHaveTextContent("Searching this room…");
        unmount();
        pending.resolve([]);
    });

    it("should report an unavailable index instead of an empty folder", async () => {
        vi.mocked(EventIndexPeg.get).mockReturnValue(null);
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);
        render(
            <FilePanel roomId={room.roomId} onClose={vi.fn()} />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent("File index unavailable");
    });

    it("should not paginate the paused old session while a debounced draft is pending", async () => {
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);
        const index = vi.mocked(EventIndexPeg.get)();
        let panel: FilePanel | null = null;
        render(
            <FilePanel
                roomId={room.roomId}
                onClose={vi.fn()}
                ref={(instance) => {
                    panel = instance;
                }}
            />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        await screen.findByText("No files visible in this room");
        const requests = vi.mocked(index!.loadFileEvents).mock.calls.length;
        fireEvent.change(screen.getByPlaceholderText("Search by file name…"), { target: { value: "draft" } });
        expect(screen.getByRole("status")).toHaveTextContent("Waiting to search…");
        expect(screen.queryByRole("button", { name: "Stop searching" })).not.toBeInTheDocument();
        const current = panel as FilePanel | null;
        if (!current) throw new Error("FilePanel not mounted");
        await expect(
            (current as unknown as { onFillRequest: (backwards: boolean) => Promise<boolean> }).onFillRequest(false),
        ).resolves.toBe(false);
        expect(vi.mocked(index!.loadFileEvents)).toHaveBeenCalledTimes(requests);
        await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("Waiting to search…"));
        expect(vi.mocked(index!.loadFileEvents).mock.calls.length).toBeGreaterThan(requests);
    });

    it("shows a blocked operation without offering a competing retry and links to index settings", async () => {
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);
        vi.spyOn(RoomFileSearchSession.prototype, "searchUntilTarget").mockResolvedValue({
            events: [],
            hasMore: false,
            scanned: 0,
            error: new WebEventIndexError({
                code: "connection_blocked",
                operation: "rpc",
                retryability: "user_action",
            }),
        });
        const dispatch = vi.spyOn(dis, "dispatch");
        render(
            <FilePanel roomId={room.roomId} onClose={vi.fn()} />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent("An earlier search operation is still pending");
        expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Go to Settings" }));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: Action.ViewUserSettings }));
    });

    it("should retry a retryable history backfill from the visible error action", async () => {
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);
        const index = {
            loadFileEvents: vi.fn().mockResolvedValue([]),
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
            crawlingRooms: vi.fn().mockReturnValue({ crawlingRooms: new Set(), totalRooms: new Set() }),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        vi.mocked(EventIndexPeg.get).mockReturnValue(index as never);

        render(
            <FilePanel roomId={room.roomId} onClose={vi.fn()} />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        await screen.findByRole("alert");
        expect(index.backfillRoom).toHaveBeenCalledOnce();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        });

        await waitFor(() => expect(index.backfillRoom).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("should retry a failed local file page from the visible error action", async () => {
        const cli = MatrixClientPeg.safeGet();
        const room = new Room("!room:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockReturnValue(room);
        const index = {
            loadFileEvents: vi
                .fn()
                .mockRejectedValueOnce(
                    new WebEventIndexError({
                        code: "network_failure",
                        operation: "loadFileEvents",
                        retryability: "retry",
                    }),
                )
                .mockResolvedValue([]),
            backfillRoom: vi.fn().mockResolvedValue({
                exhausted: true,
                scanned: 0,
                indexed: 0,
                canContinue: false,
                reason: "end",
            }),
            crawlingRooms: vi.fn().mockReturnValue({ crawlingRooms: new Set(), totalRooms: new Set() }),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        vi.mocked(EventIndexPeg.get).mockReturnValue(index as never);

        render(
            <FilePanel roomId={room.roomId} onClose={vi.fn()} />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        await screen.findByRole("alert");
        expect(index.loadFileEvents).toHaveBeenCalledOnce();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        });

        await waitFor(() => expect(index.loadFileEvents).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("should keep the latest room and tab after two same-turn resets", async () => {
        const cli = MatrixClientPeg.safeGet();
        const firstRoom = new Room("!first:server", cli, cli.getSafeUserId());
        const secondRoom = new Room("!second:server", cli, cli.getSafeUserId());
        vi.mocked(cli.getRoom).mockImplementation((id) => (id === firstRoom.roomId ? firstRoom : secondRoom));
        let panel: FilePanel | null = null;
        const { rerender } = render(
            <FilePanel
                roomId={firstRoom.roomId}
                onClose={vi.fn()}
                ref={(instance) => {
                    panel = instance;
                }}
            />,
            clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
        );
        await screen.findByText("No files visible in this room");
        rerender(
            <FilePanel
                roomId={secondRoom.roomId}
                onClose={vi.fn()}
                ref={(instance) => {
                    panel = instance;
                }}
            />,
        );
        fireEvent.click(screen.getByTestId("filter-tab-file-panel-media"));
        await waitFor(() =>
            expect(screen.getByTestId("filter-tab-file-panel-media").querySelector("input")).toBeChecked(),
        );
        const current = panel as FilePanel | null;
        if (!current) throw new Error("FilePanel not mounted");
        expect((current as unknown as { state: { search: { activeTab: string } } }).state.search.activeTab).toBe(
            "media",
        );
    });

    describe("addEncryptedLiveEvent", () => {
        it("should render a newly added file event with its jump action", async () => {
            const cli = MatrixClientPeg.safeGet();
            const room = new Room("!room:server", cli, cli.getSafeUserId());
            vi.mocked(cli.getRoom).mockReturnValue(room);

            let filePanel: FilePanel | null = null;
            const { container } = render(
                <VirtuosoMockContext.Provider value={{ viewportHeight: 400, itemHeight: 80 }}>
                    <FilePanel
                        roomId={room.roomId}
                        onClose={vi.fn()}
                        ref={(ref) => {
                            filePanel = ref;
                        }}
                    />
                </VirtuosoMockContext.Provider>,
                clientAndSDKContextRenderOptions(cli, SDKContextClass.instance),
            );
            await screen.findByText("No files visible in this room");

            const event = mkEvent({
                type: "m.room.message",
                user: cli.getSafeUserId(),
                room: room.roomId,
                content: {
                    body: "hello",
                    url: "mxc://matrix.org/1234",
                    msgtype: "m.file",
                },
                event: true,
            });
            await act(async () => {
                filePanel!.addEncryptedLiveEvent(event);
            });

            expect(await screen.findByText("hello")).toBeInTheDocument();
            expect(container.querySelector(".mx_RoomFileSearchTile")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "View in room" })).toBeInTheDocument();
        });
    });
});
