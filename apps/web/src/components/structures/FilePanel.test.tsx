/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { Room } from "matrix-js-sdk/src/matrix";
import { act, screen, render, waitFor } from "test-utils-rtl";
import { clientAndSDKContextRenderOptions, mkEvent, stubClient } from "test-utils";

import FilePanel from "./FilePanel";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { SDKContextClass } from "../../contexts/SDKContextClass.ts";

describe("FilePanel", () => {
    beforeEach(() => {
        stubClient();
    });

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
        expect(asFragment()).toMatchSnapshot();
    });

    describe("addEncryptedLiveEvent", () => {
        it("should render a newly added file event with its jump action", async () => {
            const cli = MatrixClientPeg.safeGet();
            const room = new Room("!room:server", cli, cli.getSafeUserId());
            vi.mocked(cli.getRoom).mockReturnValue(room);

            let filePanel: FilePanel | null = null;
            const { container } = render(
                <FilePanel
                    roomId={room.roomId}
                    onClose={vi.fn()}
                    ref={(ref) => {
                        filePanel = ref;
                    }}
                />,
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
            expect(container.querySelector(".mx_SearchResultTile")).toBeInTheDocument();
            expect(container.querySelector(".mx_SearchResultTile_jump")).toBeInTheDocument();
        });
    });
});
