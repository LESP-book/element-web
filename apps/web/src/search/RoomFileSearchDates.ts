/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { RoomFileSearchFilters } from "./RoomFileSearchFilters";

/** Inclusive local calendar start and exclusive next-local-midnight end for attachment filters. */
export function roomFileSearchDateBounds(
    filters: Pick<RoomFileSearchFilters, "fromDate" | "toDate">,
): { fromTs?: number; toTs?: number } | null {
    const parse = (value: string, nextDay: boolean): number | null => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const [year, month, day] = value.split("-").map(Number);
        const start = new Date(year, month - 1, day);
        // Date normalizes invalid calendar days; reject rather than silently changing the query.
        if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return null;
        return nextDay ? new Date(year, month - 1, day + 1).getTime() : start.getTime();
    };
    const fromTs = filters.fromDate ? parse(filters.fromDate, false) : undefined;
    const toTs = filters.toDate ? parse(filters.toDate, true) : undefined;
    if (fromTs === null || toTs === null || (fromTs !== undefined && toTs !== undefined && fromTs >= toTs)) {
        return null;
    }
    return { fromTs, toTs };
}
