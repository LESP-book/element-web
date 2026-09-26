/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useState } from "react";
import type { MatrixEvent } from "matrix-js-sdk/src/matrix";
import { IconButton } from "@vector-im/compound-web";
import ChevronRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-right";
import type { MediaSearchItem } from "@element-hq/web-shared-components";

import { ImageBodyFactory, VideoBodyFactory } from "../messages/MBodyFactory";
import { MediaEventHelper } from "../../../utils/MediaEventHelper";
import { _t } from "../../../languageHandler";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import type { ViewRoomPayload } from "../../../dispatcher/payloads/ViewRoomPayload";

interface Props {
    item: MediaSearchItem<MatrixEvent>;
}

/** Preview media with the existing authenticated/decrypting body, independently of message-list chrome. */
export function RoomMediaSearchTile({ item }: Readonly<Props>): JSX.Element {
    const event = item.source;
    const [helper, setHelper] = useState<MediaEventHelper>();
    useEffect(() => {
        const current = MediaEventHelper.isEligible(event) ? new MediaEventHelper(event) : undefined;
        setHelper(current);
        return () => current?.destroy();
    }, [event]);
    const onJump = (): void => {
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            event_id: item.id,
            highlighted: true,
            room_id: event.getRoomId(),
            metricsTrigger: undefined,
        });
    };

    return (
        <li className="mx_RoomMediaSearchTile" data-scroll-tokens={item.id}>
            <div className="mx_RoomMediaSearchTile_actions">
                <span className="mx_RoomMediaSearchTile_name" title={item.name}>
                    {item.name}
                </span>
                <IconButton
                    onClick={onJump}
                    aria-label={_t("timeline|mab|view_in_room")}
                    title={_t("timeline|mab|view_in_room")}
                >
                    <ChevronRightIcon />
                </IconButton>
            </div>
            <div className="mx_RoomMediaSearchTile_preview">
                {helper && event.getContent().msgtype === "m.image" ? (
                    <ImageBodyFactory mxEvent={event} mediaEventHelper={helper} maxImageHeight={180} />
                ) : helper && event.getContent().msgtype === "m.video" ? (
                    <VideoBodyFactory mxEvent={event} mediaEventHelper={helper} />
                ) : (
                    <span>{item.name}</span>
                )}
            </div>
        </li>
    );
}
