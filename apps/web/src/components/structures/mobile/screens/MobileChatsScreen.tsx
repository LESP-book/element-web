/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";

import BaseAvatar from "../../../views/avatars/BaseAvatar";
import { _t } from "../../../../languageHandler";
import { OwnProfileStore } from "../../../../stores/OwnProfileStore";
import { UPDATE_EVENT } from "../../../../stores/AsyncStore";
import { useEventEmitterState } from "../../../../hooks/useEventEmitter";
import SpaceStore from "../../../../stores/spaces/SpaceStore";
import { MetaSpace, UPDATE_SELECTED_SPACE } from "../../../../stores/spaces";
import { RoomListView } from "../../../views/rooms/RoomListPanel/RoomListView";

const SPACE_CHIPS = [
    { key: MetaSpace.Home, label: _t("common|all_chats") },
    { key: MetaSpace.People, label: _t("common|people") },
    { key: MetaSpace.Orphans, label: _t("common|rooms") },
];

interface IProps {
    onOpenSearch: () => void;
    onOpenSettings: () => void;
    onCreateChat: () => void;
}

export default function MobileChatsScreen({ onOpenSearch, onOpenSettings, onCreateChat }: IProps): JSX.Element {
    const ownProfileStore = OwnProfileStore.instance;
    const spaceStore = SpaceStore.instance;

    const profile = useEventEmitterState(ownProfileStore, UPDATE_EVENT, () => ({
        displayName: ownProfileStore.displayName || _t("settings|account|title"),
        avatarUrl: ownProfileStore.getHttpAvatarUrl(40),
    }));
    const activeSpace = useEventEmitterState(
        spaceStore,
        UPDATE_SELECTED_SPACE,
        () => spaceStore.activeSpace,
    );

    return (
        <div className="mx_MobileChatsScreen" data-testid="mx_MobileChatsScreen">
            <header className="mx_MobileChatsScreen_header">
                <button
                    type="button"
                    className="mx_MobileChatsScreen_profile"
                    aria-label={_t("settings|account|title")}
                    onClick={onOpenSettings}
                >
                    <BaseAvatar
                        name={profile.displayName}
                        idName={profile.displayName}
                        url={profile.avatarUrl}
                        size="40px"
                        altText={_t("settings|account|title")}
                    />
                    <span className="mx_MobileChatsScreen_profileLabel">{profile.displayName}</span>
                </button>
                <button
                    type="button"
                    className="mx_MobileChatsScreen_iconButton"
                    aria-label={_t("action|search")}
                    onClick={onOpenSearch}
                >
                    <SearchIcon />
                </button>
            </header>

            <div className="mx_MobileChatsScreen_spaceChips" data-testid="mx_MobileSpaceChips">
                {SPACE_CHIPS.map((chip) => (
                    <button
                        key={chip.key}
                        type="button"
                        className={`mx_MobileChatsScreen_spaceChip${
                            activeSpace === chip.key ? " mx_MobileChatsScreen_spaceChip--active" : ""
                        }`}
                        onClick={() => spaceStore.setActiveSpace(chip.key, false)}
                    >
                        {chip.label}
                    </button>
                ))}
            </div>

            <div className="mx_MobileChatsScreen_list" data-testid="mx_MobileChatsList">
                <RoomListView />
            </div>

            <button
                type="button"
                className="mx_MobileShell_fab"
                data-testid="mx_MobileShell_fab"
                aria-label={_t("action|start_chat")}
                onClick={onCreateChat}
            >
                +
            </button>
        </div>
    );
}
