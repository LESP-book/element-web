/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";
import { fireEvent, render, screen } from "test-utils-rtl";

import { RoomMediaSearchTile } from "./RoomMediaSearchTile";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { stubClient } from "test-utils";

vi.mock("../messages/MBodyFactory", () => ({
    ImageBodyFactory: () => <button type="button">Preview image</button>,
    VideoBodyFactory: () => <button type="button">Preview video</button>,
}));

const item = (msgtype: string) => ({
    id: "$media",
    name: "旅行照片.jpg",
    source: new MatrixEvent({
        event_id: "$media",
        room_id: "!room:test",
        type: "m.room.message",
        sender: "@alice:test",
        content: { msgtype, body: "旅行照片.jpg", url: "mxc://example.org/media" },
    }),
});

describe("RoomMediaSearchTile", () => {
    beforeEach(() => stubClient());
    it.each([
        ["m.image", "Preview image"],
        ["m.video", "Preview video"],
    ])("renders %s using the existing media preview and a separate jump action", (msgtype, preview) => {
        const dispatch = vi.spyOn(dis, "dispatch").mockImplementation(() => undefined);
        const { container } = render(<RoomMediaSearchTile item={item(msgtype)} />);
        expect(screen.getByRole("button", { name: preview })).toBeInTheDocument();
        const tile = container.querySelector(".mx_RoomMediaSearchTile");
        expect(tile?.children[0]).toHaveClass("mx_RoomMediaSearchTile_actions");
        expect(tile?.children[1]).toHaveClass("mx_RoomMediaSearchTile_preview");
        fireEvent.click(screen.getByRole("button", { name: "View in room" }));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: Action.ViewRoom, event_id: "$media" }));
        dispatch.mockRestore();
    });
});
