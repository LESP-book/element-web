/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { MatrixEvent } from "matrix-js-sdk/src/matrix";

import type { RoomFileSearchFilters } from "./RoomFileSearchFilters";
import { roomFileSearchDateBounds } from "./RoomFileSearchDates";

const MEDIA = new Set(["m.image", "m.video"]);
const FILES = new Set(["m.file", "m.audio"]);

/** Apply the same attachment category/name rules to local pages and live Timeline events. */
export function matchesRoomFileSearchEvent(
    event: MatrixEvent,
    category: "media" | "files",
    term: string,
    filters?: RoomFileSearchFilters,
): boolean {
    if (event.getType() !== "m.room.message" || event.isRedacted()) return false;
    const content = event.getContent();
    const types = category === "media" ? MEDIA : FILES;
    if (typeof content.msgtype !== "string" || !types.has(content.msgtype)) return false;
    if (filters?.type !== "all" && filters?.type && filters.type !== content.msgtype) return false;
    if (filters?.sender && event.getSender() !== filters.sender.trim()) return false;
    const bounds = filters ? roomFileSearchDateBounds(filters) : undefined;
    if (bounds === null || (bounds?.fromTs !== undefined && event.getTs() < bounds.fromTs)) return false;
    if (bounds?.toTs !== undefined && event.getTs() >= bounds.toTs) return false;
    const query = term.trim().toLowerCase();
    return (
        !query ||
        [content.filename, content.body].some((name) => typeof name === "string" && name.toLowerCase().includes(query))
    );
}
