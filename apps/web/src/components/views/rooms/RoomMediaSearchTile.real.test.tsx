/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";
import { render, screen } from "test-utils-rtl";
import { stubClient } from "test-utils";

import RoomContext, { TimelineRenderingType } from "../../../contexts/RoomContext";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import { RoomMediaSearchTile } from "./RoomMediaSearchTile";

describe("RoomMediaSearchTile with real message bodies", () => {
    it.each(["m.image", "m.video"])("keeps the built-in download action for %s", async (msgtype) => {
        stubClient();
        const event = new MatrixEvent({
            event_id: `$${msgtype}`,
            room_id: "!room:test",
            type: "m.room.message",
            sender: "@alice:test",
            content: {
                msgtype,
                body: "旅行照片.jpg",
                url: "mxc://example.org/media",
                info: { mimetype: msgtype === "m.image" ? "image/jpeg" : "video/mp4", size: 80 },
            },
        });
        // Use the real File timeline context; Search would incorrectly suppress the download body.
        const wrapper = ({ children }: { children: React.ReactNode }): React.ReactNode => (
            <MatrixClientContext.Provider value={MatrixClientPeg.safeGet()}>
                <RoomContext.Provider
                    value={
                        { timelineRenderingType: TimelineRenderingType.File } as React.ContextType<typeof RoomContext>
                    }
                >
                    {children}
                </RoomContext.Provider>
            </MatrixClientContext.Provider>
        );
        render(<RoomMediaSearchTile item={{ id: event.getId()!, name: "旅行照片.jpg", source: event }} />, { wrapper });
        expect(await screen.findByRole("button", { name: "View in room" })).toBeInTheDocument();
        const download = screen.getByText(/Download/i);
        expect(download.closest("a, button, [role=button]")).not.toBeNull();
    });
});
