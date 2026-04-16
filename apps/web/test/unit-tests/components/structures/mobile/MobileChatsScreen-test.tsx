/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { fireEvent, render, screen } from "jest-matrix-react";
import { Room } from "matrix-js-sdk/src/matrix";

import MobileChatsScreen from "../../../../../src/components/structures/mobile/screens/MobileChatsScreen";
import { OwnProfileStore } from "../../../../../src/stores/OwnProfileStore";
import SpaceStore from "../../../../../src/stores/spaces/SpaceStore";
import { MetaSpace } from "../../../../../src/stores/spaces";
import { stubClient } from "../../../../test-utils/test-utils";

jest.mock("../../../../../src/components/views/rooms/RoomListPanel/RoomListView", () => ({
    RoomListView: () => <div data-testid="mx_RoomListView" />,
}));

describe("<MobileChatsScreen />", () => {
    beforeEach(() => {
        stubClient();
        jest.spyOn(OwnProfileStore.instance, "displayName", "get").mockReturnValue("Alice");
        jest.spyOn(OwnProfileStore.instance, "getHttpAvatarUrl").mockReturnValue("https://example.org/avatar.png");
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function makeSpace(roomId: string, name: string): Room {
        const room = new Room(roomId, stubClient(), "@user:matrix.org");
        Object.defineProperty(room, "name", { configurable: true, value: name });
        room.isSpaceRoom = jest.fn().mockReturnValue(true);
        return room;
    }

    it("renders meta spaces together with user-created spaces", () => {
        const spaceA = makeSpace("!space-a:server", "Space Alpha");
        const spaceB = makeSpace("!space-b:server", "Space Beta");

        jest.spyOn(SpaceStore.instance, "activeSpace", "get").mockReturnValue(MetaSpace.Home);
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([spaceA, spaceB]);

        render(<MobileChatsScreen onOpenSearch={jest.fn()} onOpenSettings={jest.fn()} onCreateChat={jest.fn()} />);

        expect(screen.getByRole("button", { name: "Space Alpha" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Space Beta" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "All Chats" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "People" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Other rooms" })).not.toBeInTheDocument();
        expect(screen.getByTestId("mx_MobileSpaceChips").querySelectorAll("button")).toHaveLength(3);
    });

    it("switches the active space when a user-created space chip is pressed", () => {
        const spaceA = makeSpace("!space-a:server", "Space Alpha");
        const setActiveSpace = jest.spyOn(SpaceStore.instance, "setActiveSpace").mockImplementation(jest.fn());

        jest.spyOn(SpaceStore.instance, "activeSpace", "get").mockReturnValue(MetaSpace.Home);
        jest.spyOn(SpaceStore.instance, "spacePanelSpaces", "get").mockReturnValue([spaceA]);

        render(<MobileChatsScreen onOpenSearch={jest.fn()} onOpenSettings={jest.fn()} onCreateChat={jest.fn()} />);

        fireEvent.click(screen.getByRole("button", { name: "Space Alpha" }));

        expect(setActiveSpace).toHaveBeenCalledWith(spaceA.roomId, false);
    });

    it("calls the search callback when the search action is pressed", () => {
        const onOpenSearch = jest.fn();

        render(<MobileChatsScreen onOpenSearch={onOpenSearch} onOpenSettings={jest.fn()} onCreateChat={jest.fn()} />);

        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });
});
