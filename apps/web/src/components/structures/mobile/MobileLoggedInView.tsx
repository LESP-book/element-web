/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, {
    cloneElement,
    type JSX,
    type ReactElement,
    type ReactNode,
    isValidElement,
    useCallback,
    useEffect,
    useState,
} from "react";
import classNames from "classnames";
import NotificationsIcon from "@vector-im/compound-design-tokens/assets/web/icons/notifications";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";
import ChevronLeftIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-left";

import PageTypes from "../../../PageTypes";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { _t } from "../../../languageHandler";
import NotificationPanel from "../NotificationPanel";
import { UserSettingsView } from "../../views/dialogs/UserSettingsDialog";
import { type SdkContextClass } from "../../../contexts/SDKContext";
import MobileChatsScreen from "./screens/MobileChatsScreen";
import { UPDATE_EVENT } from "../../../stores/AsyncStore";

type Destination = "chats" | "notifications" | "settings";
type ViewState = Destination | "room";
type MobileRoomPageElementProps = {
    hideHeader?: boolean;
    mobileRightPanelMode?: "overlay";
    showMobileHeaderActions?: boolean;
};

interface IProps {
    pageType?: PageTypes;
    pageElement?: ReactNode;
    sdkContext: SdkContextClass;
}

export default function MobileLoggedInView({ pageType, pageElement, sdkContext }: IProps): JSX.Element {
    const isRoomViewPage = pageType === PageTypes.RoomView;
    const isRoomPage = isRoomViewPage || pageType === PageTypes.UserView;
    const [viewState, setViewState] = useState<ViewState>(isRoomPage ? "room" : "chats");
    const [isRoomInfoOpen, setIsRoomInfoOpen] = useState(false);
    const currentRoomId = isRoomViewPage ? sdkContext.roomViewStore.getRoomId() : null;
    const currentRoom = currentRoomId ? sdkContext.client?.getRoom(currentRoomId) : null;
    const roomName = currentRoom?.name || _t("common|unnamed_room");

    useEffect(() => {
        if (isRoomPage) {
            setViewState("room");
        } else {
            setViewState((currentViewState) => (currentViewState === "room" ? "chats" : currentViewState));
            setIsRoomInfoOpen(false);
        }
    }, [isRoomPage]);

    const onBackToChats = useCallback(() => {
        if (currentRoomId && isRoomInfoOpen) {
            sdkContext.rightPanelStore.hide(currentRoomId);
            return;
        }
        dis.dispatch({ action: Action.ViewHomePage });
    }, [currentRoomId, isRoomInfoOpen, sdkContext]);

    useEffect(() => {
        if (!currentRoomId) {
            setIsRoomInfoOpen(false);
            return;
        }

        const onRightPanelUpdate = (): void => {
            setIsRoomInfoOpen(sdkContext.rightPanelStore.isOpenForRoom(currentRoomId));
        };

        onRightPanelUpdate();
        sdkContext.rightPanelStore.on(UPDATE_EVENT, onRightPanelUpdate);

        return () => {
            sdkContext.rightPanelStore.off(UPDATE_EVENT, onRightPanelUpdate);
        };
    }, [currentRoomId, sdkContext]);

    const mobileRoomPageElement =
        isRoomViewPage && isValidElement(pageElement)
            ? cloneElement(pageElement as ReactElement<MobileRoomPageElementProps>, {
                  hideHeader: true,
                  mobileRightPanelMode: "overlay",
                  showMobileHeaderActions: true,
              })
            : pageElement;

    const chatsLabel = "Chats";
    const notificationsLabel = _t("notifications|enable_prompt_toast_title");
    const settingsLabel = _t("common|settings");

    let content: ReactNode;
    if (viewState === "notifications") {
        content = (
            <div
                className="mx_MobileShell_screen mx_MobileShell_screen--stack"
                data-testid="mx_MobileNotificationsScreen"
            >
                <NotificationPanel onClose={() => setViewState("chats")} />
            </div>
        );
    } else if (viewState === "settings") {
        content = (
            <div
                className="mx_MobileShell_screen mx_MobileShell_screen--settings"
                data-testid="mx_MobileSettingsScreen"
            >
                <UserSettingsView embedded={true} onFinished={() => setViewState("chats")} sdkContext={sdkContext} />
            </div>
        );
    } else if (viewState === "room") {
        content = (
            <div className="mx_MobileShell_screen mx_MobileShell_screen--room" data-testid="mx_MobileRoomScreen">
                <div className="mx_MobileShell_roomBackBar" data-testid="mx_MobileShell_roomBackBar">
                    <button
                        type="button"
                        className="mx_MobileShell_iconButton"
                        aria-label={_t("action|back")}
                        data-testid="mx_MobileShell_backButton"
                        onClick={onBackToChats}
                    >
                        <ChevronLeftIcon />
                    </button>
                    <div className="mx_MobileShell_title">{roomName}</div>
                </div>
                {mobileRoomPageElement}
            </div>
        );
    } else {
        content = (
            <div className="mx_MobileShell_screen mx_MobileShell_screen--chats">
                <MobileChatsScreen
                    onOpenSearch={() => dis.dispatch({ action: Action.OpenSpotlight })}
                    onOpenSettings={() => setViewState("settings")}
                    onCreateChat={() => dis.dispatch({ action: Action.CreateChat })}
                />
            </div>
        );
    }

    const title =
        viewState === "notifications" ? notificationsLabel : viewState === "settings" ? settingsLabel : chatsLabel;
    const navItems: Array<{
        id: Destination;
        label: string;
        Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    }> = [
        { id: "chats", label: chatsLabel, Icon: ChatIcon },
        { id: "notifications", label: notificationsLabel, Icon: NotificationsIcon },
        { id: "settings", label: settingsLabel, Icon: SettingsIcon },
    ];

    const showBottomNav = viewState !== "room";
    const showAppBar = showBottomNav && viewState !== "chats";

    return (
        <div className="mx_MobileShell" data-testid="mx_MobileShell">
            {showAppBar && (
                <header className="mx_MobileShell_appBar">
                    <div className="mx_MobileShell_title">{title}</div>
                </header>
            )}
            <main className={classNames("mx_MobileShell_content", { mx_MobileShell_content__room: !showBottomNav })}>
                {content}
            </main>
            {showBottomNav && (
                <nav
                    className="mx_MobileShell_bottomNav"
                    aria-label="Navigation"
                    data-testid="mx_MobileShell_bottomNav"
                >
                    {navItems.map(({ id, label, Icon }) => (
                        <button
                            key={id}
                            type="button"
                            className={classNames("mx_MobileShell_navItem", {
                                "mx_MobileShell_navItem--active": viewState === id,
                            })}
                            data-testid={`mx_MobileShell_nav_${id}`}
                            onClick={() => setViewState(id)}
                        >
                            <Icon />
                            <span>{label}</span>
                        </button>
                    ))}
                </nav>
            )}
        </div>
    );
}
