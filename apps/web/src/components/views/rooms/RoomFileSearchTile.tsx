/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useMemo } from "react";
import type { MatrixEvent } from "matrix-js-sdk/src/matrix";
import ChevronRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-right";
import { IconButton } from "@vector-im/compound-web";

import { FileBodyFactory } from "../messages/MBodyFactory";
import { MediaEventHelper } from "../../../utils/MediaEventHelper";
import { formatTime } from "../../../DateUtils";
import { formatBytes } from "../../../utils/FormattingUtils";
import { _t } from "../../../languageHandler";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import type { ViewRoomPayload } from "../../../dispatcher/payloads/ViewRoomPayload";

interface Props {
    event: MatrixEvent;
}

/** Compact file result with existing secure preview/download and an independent jump action. */
export function RoomFileSearchTile({ event }: Readonly<Props>): JSX.Element | null {
    const helper = useMemo(
        () => (MediaEventHelper.isEligible(event) ? new MediaEventHelper(event) : undefined),
        [event],
    );
    useEffect(() => () => helper?.destroy(), [helper]);
    const eventId = event.getId();
    if (!eventId) return null;
    const content = event.getContent();
    const name = content.filename || content.body || "";
    const size = typeof content.info?.size === "number" ? formatBytes(content.info.size) : "";
    const onJump = (): void => {
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            event_id: eventId,
            highlighted: true,
            room_id: event.getRoomId(),
            metricsTrigger: undefined,
        });
    };
    return (
        <div className="mx_RoomFileSearchTile" role="listitem" data-scroll-tokens={eventId}>
            <div className="mx_RoomFileSearchTile_content">
                <div className="mx_RoomFileSearchTile_name" title={name}>
                    {helper ? <FileBodyFactory mxEvent={event} mediaEventHelper={helper} showFileInfo /> : name}
                </div>
                <div className="mx_RoomFileSearchTile_meta">
                    {[content.info?.mimetype, size, event.getSender(), formatTime(new Date(event.getTs()), false)]
                        .filter(Boolean)
                        .join(" · ")}
                </div>
            </div>
            <IconButton
                onClick={onJump}
                aria-label={_t("timeline|mab|view_in_room")}
                title={_t("timeline|mab|view_in_room")}
            >
                <ChevronRightIcon />
            </IconButton>
        </div>
    );
}
