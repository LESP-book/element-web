/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "test-utils-rtl";

import RoomSearchAuxPanel from "./RoomSearchAuxPanel";
import { SearchScope } from "../../../Searching";

describe("RoomSearchAuxPanel", () => {
    it("should render the count of results", () => {
        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    count: 5,
                    term: "abcd",
                    scope: SearchScope.Room,
                    promise: new Promise(() => {}),
                }}
                isRoomEncrypted={false}
                onCancelClick={vi.fn()}
            />,
        );

        expect(screen.getByText("5 results found so far for", { exact: false })).toHaveTextContent(
            "5 results found so far for “abcd”",
        );
    });

    it("should not offer a scope which still searches only this room", () => {
        render(<RoomSearchAuxPanel isRoomEncrypted={false} onCancelClick={vi.fn()} />);
        expect(screen.queryByText("Search all rooms")).not.toBeInTheDocument();
    });

    it("should allow the user to cancel a search", async () => {
        const onCancelClick = vi.fn();

        render(<RoomSearchAuxPanel isRoomEncrypted={false} onCancelClick={onCancelClick} />);

        screen.getByRole("button", { name: "Cancel" }).click();
        expect(onCancelClick).toHaveBeenCalled();
    });
});
