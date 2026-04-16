/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { fireEvent, render, screen } from "jest-matrix-react";

import MobileLoggedInView from "../../../../src/components/structures/mobile/MobileLoggedInView";
import PageTypes from "../../../../src/PageTypes";
import { TestSdkContext } from "../../TestSdkContext";
import dis from "../../../../src/dispatcher/dispatcher";
import { Action } from "../../../../src/dispatcher/actions";
import { stubClient } from "../../../test-utils/test-utils";

jest.mock("../../../../src/components/structures/NotificationPanel", () => () => <div>Mock Notifications</div>);
jest.mock("../../../../src/components/views/dialogs/UserSettingsDialog", () => ({
    UserSettingsView: () => <div>Mock Settings</div>,
}));

function MockRoomView({
    hideHeader,
    mobileRightPanelMode,
    showMobileHeaderActions,
}: {
    hideHeader?: boolean;
    mobileRightPanelMode?: string;
    showMobileHeaderActions?: boolean;
}): React.JSX.Element {
    return (
        <div
            data-testid="mock-room-view"
            data-hide-header={String(Boolean(hideHeader))}
            data-mobile-right-panel-mode={mobileRightPanelMode ?? ""}
            data-show-mobile-header-actions={String(Boolean(showMobileHeaderActions))}
        >
            Mock Room View
        </div>
    );
}

function makeRoomSdkContext(roomName = "Mobile Alpha"): TestSdkContext {
    const sdkContext = new TestSdkContext();
    const client = stubClient();
    const roomId = "!mobile-alpha:example.org";

    sdkContext.client = client;
    jest.spyOn(sdkContext.roomViewStore, "getRoomId").mockReturnValue(roomId);
    client.getRoom = jest.fn().mockReturnValue({
        roomId,
        name: roomName,
    });

    return sdkContext;
}

describe("<MobileLoggedInView />", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("restores the top-level shell when navigation leaves the room screen", () => {
        const { rerender } = render(
            <MobileLoggedInView
                pageType={PageTypes.RoomView}
                pageElement={<MockRoomView />}
                sdkContext={makeRoomSdkContext()}
            />,
        );

        expect(screen.getByTestId("mx_MobileRoomScreen")).toBeInTheDocument();
        expect(screen.queryByTestId("mx_MobileShell_bottomNav")).not.toBeInTheDocument();

        rerender(
            <MobileLoggedInView
                pageType={PageTypes.HomePage}
                pageElement={<div>Mock Home View</div>}
                sdkContext={new TestSdkContext()}
            />,
        );

        expect(screen.getByTestId("mx_MobileChatsScreen")).toBeInTheDocument();
        expect(screen.queryByTestId("mx_MobileRoomScreen")).not.toBeInTheDocument();
        expect(screen.getByTestId("mx_MobileShell_bottomNav")).toBeInTheDocument();
        expect(document.querySelector(".mx_MobileShell_appBar")).toBeNull();
    });

    it("renders a back button in room view that navigates to home", () => {
        const dispatchSpy = jest.spyOn(dis, "dispatch");
        const sdkContext = makeRoomSdkContext("Mobile Alpha");

        render(
            <MobileLoggedInView pageType={PageTypes.RoomView} pageElement={<MockRoomView />} sdkContext={sdkContext} />,
        );

        const backButton = screen.getByTestId("mx_MobileShell_backButton");
        expect(backButton).toBeInTheDocument();
        expect(screen.getByTestId("mx_MobileShell_roomBackBar")).toBeInTheDocument();
        expect(screen.getByText("Mobile Alpha")).toBeInTheDocument();
        expect(screen.queryByTestId("mx_MobileShell_roomInfoButton")).not.toBeInTheDocument();
        expect(screen.getByTestId("mock-room-view")).toHaveAttribute("data-hide-header", "true");
        expect(screen.getByTestId("mock-room-view")).toHaveAttribute("data-mobile-right-panel-mode", "overlay");
        expect(screen.getByTestId("mock-room-view")).toHaveAttribute("data-show-mobile-header-actions", "true");

        fireEvent.click(backButton);
        expect(dispatchSpy).toHaveBeenCalledWith({ action: Action.ViewHomePage });

        dispatchSpy.mockRestore();
    });

    it("uses the back button to close an open mobile room info panel before leaving the room", () => {
        const sdkContext = makeRoomSdkContext("Mobile Beta");
        const hideSpy = jest.spyOn(sdkContext.rightPanelStore, "hide");
        const dispatchSpy = jest.spyOn(dis, "dispatch");
        jest.spyOn(sdkContext.rightPanelStore, "isOpenForRoom").mockReturnValue(true);

        render(
            <MobileLoggedInView pageType={PageTypes.RoomView} pageElement={<MockRoomView />} sdkContext={sdkContext} />,
        );

        fireEvent.click(screen.getByTestId("mx_MobileShell_backButton"));

        expect(hideSpy).toHaveBeenCalledWith("!mobile-alpha:example.org");
        expect(screen.getByTestId("mx_MobileRoomScreen")).toBeInTheDocument();
        expect(screen.queryByTestId("mx_MobileRoomInfoScreen")).not.toBeInTheDocument();
        expect(dispatchSpy).not.toHaveBeenCalledWith({ action: Action.ViewHomePage });
    });

    it("does not render a back button on non-room views", () => {
        render(
            <MobileLoggedInView
                pageType={PageTypes.HomePage}
                pageElement={<div>Mock Home View</div>}
                sdkContext={new TestSdkContext()}
            />,
        );

        expect(screen.queryByTestId("mx_MobileShell_backButton")).not.toBeInTheDocument();
        expect(screen.queryByTestId("mx_MobileShell_roomBackBar")).not.toBeInTheDocument();
    });
});
