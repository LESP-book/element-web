/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Attachment filters are part of the query identity, never applied to only visible rows. */
export interface RoomFileSearchFilters {
    sender: string;
    fromDate: string;
    toDate: string;
    type: "all" | "m.image" | "m.video" | "m.file" | "m.audio";
}
