/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, memo, type ReactNode } from "react";
import { Text, Tooltip } from "@vector-im/compound-web";
import classNames from "classnames";

import { Flex } from "../../../../core/utils/Flex";
import { useViewModel } from "../../../../core/viewmodel";
import { NotificationDecoration } from "./NotificationDecoration";
import { RoomListItemHoverMenu } from "./RoomListItemHoverMenu";
import { type Room, type RoomListItemViewModel } from "./RoomListItemView";
import styles from "./RoomListItemView.module.css";

/**
 * Props for {@link RoomListItemContent}.
 */
export interface RoomListItemContentProps {
    /** The room item view model */
    vm: RoomListItemViewModel;
    /** Function to render the room avatar */
    renderAvatar: (room: Room) => ReactNode;
    /** Whether the item is being dragged */
    isDragging?: boolean;
}

/**
 * The inner content of a room list item: avatar, room name, message preview,
 * hover menu and notification decoration. Used both inside the full
 * {@link RoomListItemView} and inside the drag overlay.
 */
export const RoomListItemContent = memo(function RoomListItemContent({
    vm,
    renderAvatar,
    isDragging = false,
}: RoomListItemContentProps): JSX.Element {
    const item = useViewModel(vm);

    return (
        <Flex
            className={classNames(styles.container, {
                [styles.dragging]: isDragging,
            })}
            gap="var(--cpd-space-3x)"
            align="center"
        >
            <div className={styles.avatarSlot} data-testid="room-list-item-avatar-slot">
                {renderAvatar(item.room)}
                {/* 保持未读角标贴在头像上，避免窄侧栏里与内容区错位。 */}
                <div
                    className={styles.notificationDecoration}
                    aria-hidden={true}
                    data-testid="room-list-item-notification-decoration"
                >
                    <NotificationDecoration {...item.notification} />
                </div>
            </div>
            <Flex
                className={styles.content}
                gap="var(--cpd-space-2x)"
                align="center"
                justify="space-between"
                data-testid="room-list-item-content"
            >
                {/* We truncate the room name when too long. Title here is to show the full name on hover */}
                <div className={styles.ellipsis}>
                    <div className={styles.roomName} title={item.name} data-testid="room-name">
                        {item.name}
                        {item.userStatus && (
                            <Tooltip description={item.userStatus.text}>
                                <Text as="span" className={styles.userStatusEmoji}>
                                    {item.userStatus.emoji}
                                </Text>
                            </Tooltip>
                        )}
                    </div>

                    {item.messagePreview && (
                        <Text as="div" size="sm" className={styles.ellipsis} title={item.messagePreview}>
                            {item.messagePreview}
                        </Text>
                    )}
                </div>
                {!isDragging && (item.showMoreOptionsMenu || item.showNotificationMenu) && (
                    <RoomListItemHoverMenu
                        showMoreOptionsMenu={item.showMoreOptionsMenu}
                        showNotificationMenu={item.showNotificationMenu}
                        vm={vm}
                    />
                )}

            </Flex>
        </Flex>
    );
});
