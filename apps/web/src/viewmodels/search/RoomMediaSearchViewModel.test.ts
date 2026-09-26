/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";

import { RoomMediaSearchViewModel } from "./RoomMediaSearchViewModel";

describe("RoomMediaSearchViewModel", () => {
    it("should group photos by month in single-column rows at any width", () => {
        const events = [0, 1, 2, 3, 4].map(
            (i) =>
                new MatrixEvent({
                    event_id: `$photo${i}`,
                    origin_server_ts: Date.UTC(2026, i === 4 ? 7 : 8, 1),
                    type: "m.room.message",
                    content: { msgtype: "m.image", body: `Photo ${i}` },
                }),
        );
        const vm = new RoomMediaSearchViewModel({ onEndReached: () => {} });
        vm.updateResults(events, false);
        expect(vm.getSnapshot().rows.map((row) => row.key)).toEqual([
            "month-2026-8",
            "row-$photo0",
            "row-$photo1",
            "row-$photo2",
            "row-$photo3",
            "month-2026-7",
            "row-$photo4",
        ]);
        vm.updateResults(events, true);
        expect(vm.getSnapshot().columns).toBe(1);
        expect(vm.getSnapshot().rows.map((row) => row.key)).toEqual([
            "month-2026-8",
            "row-$photo0",
            "row-$photo1",
            "row-$photo2",
            "row-$photo3",
            "month-2026-7",
            "row-$photo4",
        ]);
        vm.dispose();
    });
});
