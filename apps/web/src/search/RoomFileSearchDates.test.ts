/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { roomFileSearchDateBounds } from "./RoomFileSearchDates";

describe("roomFileSearchDateBounds", () => {
    it("rejects invalid calendar days and reversed date ranges", () => {
        expect(roomFileSearchDateBounds({ fromDate: "2026-02-31", toDate: "" })).toBeNull();
        expect(roomFileSearchDateBounds({ fromDate: "2026-04-02", toDate: "2026-04-01" })).toBeNull();
    });

    it("ends at the next local midnight, including daylight saving transitions", () => {
        const bounds = roomFileSearchDateBounds({ fromDate: "2026-03-08", toDate: "2026-03-08" });
        expect(bounds).toEqual({
            fromTs: new Date(2026, 2, 8).getTime(),
            toTs: new Date(2026, 2, 9).getTime(),
        });
        if (new Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York") {
            expect(bounds!.toTs! - bounds!.fromTs!).toBe(23 * 60 * 60 * 1000);
        }
    });
});
