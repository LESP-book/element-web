/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useEffect, useState } from "react";
import classNames from "classnames";
import NotificationsIcon from "@vector-im/compound-design-tokens/assets/web/icons/notifications";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";

import PageTypes from "../../../PageTypes";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { _t } from "../../../languageHandler";
import NotificationPanel from "../NotificationPanel";
import { UserSettingsView } from "../../views/dialogs/UserSettingsDialog";
import { type SdkContextClass } from "../../../contexts/SDKContext";
import MobileChatsScreen from "./screens/MobileChatsScreen";

type Destination = "chats" | "notifications" | "settings";
type ViewState = Destination | "room";

interface IProps {
    pageType?: PageTypes;
    pageElement?: ReactNode;
    sdkContext: SdkContextClass;
}

export default function MobileLoggedInView({ pageType, pageElement, sdkContext }: IProps): JSX.Element {
    const isRoomPage = pageType === PageTypes.RoomView || pageType === PageTypes.UserView;
    const [viewState, setViewState] = useState<ViewState>(isRoomPage ? "room" : "chats");

    useEffect(() => {
        if (isRoomPage) {
            setViewState("room");
        } else {
            setViewState((currentViewState) => (currentViewState === "room" ? "chats" : currentViewState));
        }
    }, [isRoomPage]);

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
                className="mx_MobileShell_screen mx_MobileShell_screen--stack"
                data-testid="mx_MobileSettingsScreen"
            >
                <UserSettingsView embedded={true} onFinished={() => setViewState("chats")} sdkContext={sdkContext} />
            </div>
        );
    } else if (viewState === "room") {
        content = (
            <div className="mx_MobileShell_screen mx_MobileShell_screen--room" data-testid="mx_MobileRoomScreen">
                {pageElement}
            </div>
        );
    } else {
        content = (
            <div className="mx_MobileShell_screen mx_MobileShell_screen--chats">
                <MobileChatsScreen
                    onOpenSearch={() => dis.dispatch({ action: Action.ViewRoomDirectory })}
                    onOpenSettings={() => setViewState("settings")}
                    onCreateChat={() => dis.dispatch({ action: Action.CreateChat })}
                />
            </div>
        );
    }

    const title =
        viewState === "notifications"
            ? notificationsLabel
            : viewState === "settings"
              ? settingsLabel
              : chatsLabel;
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

    return (
        <div className="mx_MobileShell" data-testid="mx_MobileShell">
            {showBottomNav && (
                <header className="mx_MobileShell_appBar">
                    <div className="mx_MobileShell_title">{title}</div>
                </header>
            )}
            <main className={classNames("mx_MobileShell_content", { mx_MobileShell_content__room: !showBottomNav })}>
                {content}
            </main>
            {showBottomNav && (
                <nav className="mx_MobileShell_bottomNav" aria-label="Navigation" data-testid="mx_MobileShell_bottomNav">
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
