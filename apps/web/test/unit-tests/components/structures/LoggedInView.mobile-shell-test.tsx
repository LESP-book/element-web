/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { render, screen } from "jest-matrix-react";
import { MediaHandler } from "matrix-js-sdk/src/webrtc/mediaHandler";
import { PushProcessor } from "matrix-js-sdk/src/pushprocessor";

import LoggedInView from "../../../../src/components/structures/LoggedInView";
import { SDKContext } from "../../../../src/contexts/SDKContext";
import ResizeNotifier from "../../../../src/utils/ResizeNotifier";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../../../test-utils";
import { TestSdkContext } from "../../TestSdkContext";
import PageTypes from "../../../../src/PageTypes";

jest.mock("../../../../src/components/structures/HomePage", () => () => <div>Mock Home Page</div>);
jest.mock("../../../../src/components/structures/LeftPanel", () => () => <div>Mock Left Panel</div>);
jest.mock("../../../../src/components/views/spaces/SpacePanel", () => () => <div>Mock Space Panel</div>);
jest.mock("../../../../src/components/structures/RoomView", () => ({
    RoomView: () => <div>Mock Room View</div>,
}));

describe("<LoggedInView /> mobile shell", () => {
    const userId = "@alice:domain.org";
    const mockClient = getMockClientWithEventEmitter({
        ...mockClientMethodsUser(userId),
        getAccountData: jest.fn(),
        getRoom: jest.fn(),
        getSyncState: jest.fn().mockReturnValue(null),
        getSyncStateData: jest.fn().mockReturnValue(null),
        getMediaHandler: jest.fn(),
        setPushRuleEnabled: jest.fn(),
        setPushRuleActions: jest.fn(),
        getCrypto: jest.fn().mockReturnValue(undefined),
        getVisibleRooms: jest.fn().mockReturnValue([]),
        getRooms: jest.fn().mockReturnValue([]),
        getClientWellKnown: jest.fn().mockReturnValue(undefined),
        deleteExtendedProfileProperty: jest.fn().mockResolvedValue(undefined),
    });
    const mediaHandler = new MediaHandler(mockClient);
    const sdkContext = new TestSdkContext();

    const defaultProps = {
        matrixClient: mockClient,
        onRegistered: jest.fn(),
        resizeNotifier: new ResizeNotifier(),
        collapseLhs: false,
        hideToSRUsers: false,
        config: {
            brand: "Test",
            element_call: {},
            mobile_web_shell_enabled: true,
        },
        page_type: PageTypes.HomePage,
        currentRoomId: "",
        currentUserId: "@bob:server",
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.getMediaHandler.mockReturnValue(mediaHandler);
        // @ts-expect-error test-only
        mockClient.pushProcessor = new PushProcessor(mockClient);
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
        jest.spyOn(window, "matchMedia").mockImplementation(
            (query: string) =>
                ({
                    matches: query === "(pointer: coarse)",
                    media: query,
                    onchange: null,
                    addListener: jest.fn(),
                    removeListener: jest.fn(),
                    addEventListener: jest.fn(),
                    removeEventListener: jest.fn(),
                    dispatchEvent: jest.fn(),
                }) as MediaQueryList,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("renders the dedicated mobile shell with top-level mobile destinations on phones", () => {
        const { container } = render(<LoggedInView {...defaultProps} />, {
            wrapper: ({ children }) => <SDKContext.Provider value={sdkContext}>{children}</SDKContext.Provider>,
        });

        expect(screen.getByTestId("mx_MobileShell")).toBeInTheDocument();
        expect(screen.getByTestId("mx_MobileChatsScreen")).toBeInTheDocument();
        expect(screen.getByTestId("mx_MobileShell_nav_chats")).toBeInTheDocument();
        expect(container.querySelector("#lp-resizer")).not.toBeInTheDocument();
    });
});
