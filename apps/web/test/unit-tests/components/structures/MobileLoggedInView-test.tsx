/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { render, screen } from "jest-matrix-react";

import MobileLoggedInView from "../../../../src/components/structures/mobile/MobileLoggedInView";
import PageTypes from "../../../../src/PageTypes";
import { TestSdkContext } from "../../TestSdkContext";

jest.mock("../../../../src/components/structures/NotificationPanel", () => () => <div>Mock Notifications</div>);
jest.mock("../../../../src/components/views/dialogs/UserSettingsDialog", () => ({
    UserSettingsView: () => <div>Mock Settings</div>,
}));

describe("<MobileLoggedInView />", () => {
    it("restores the top-level shell when navigation leaves the room screen", () => {
        const { rerender } = render(
            <MobileLoggedInView
                pageType={PageTypes.RoomView}
                pageElement={<div>Mock Room View</div>}
                sdkContext={new TestSdkContext()}
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
    });
});
