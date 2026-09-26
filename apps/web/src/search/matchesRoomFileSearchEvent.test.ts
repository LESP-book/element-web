/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";

import { matchesRoomFileSearchEvent } from "./matchesRoomFileSearchEvent";

describe("matchesRoomFileSearchEvent", () => {
    it("should match both filenames and bodies without crossing media/file categories", () => {
        const file = new MatrixEvent({
            type: "m.room.message",
            content: { msgtype: "m.file", filename: "合同.pdf", body: "summary" },
        });
        expect(matchesRoomFileSearchEvent(file, "files", "合同")).toBe(true);
        expect(matchesRoomFileSearchEvent(file, "files", "SUMMARY")).toBe(true);
        expect(matchesRoomFileSearchEvent(file, "media", "合同")).toBe(false);
        expect(matchesRoomFileSearchEvent(file, "files", "unrelated")).toBe(false);
    });

    it("uses the same sender, type and local date filters for live and fallback pages", () => {
        const day = new Date(2026, 2, 8, 23, 30).getTime();
        const file = new MatrixEvent({
            type: "m.room.message",
            sender: "@alice:test",
            origin_server_ts: day,
            content: { msgtype: "m.file", filename: "report.pdf" },
        });
        const filters = {
            sender: "@alice:test",
            type: "m.file" as const,
            fromDate: "2026-03-08",
            toDate: "2026-03-08",
        };
        expect(matchesRoomFileSearchEvent(file, "files", "report", filters)).toBe(true);
        expect(matchesRoomFileSearchEvent(file, "files", "report", { ...filters, sender: "@bob:test" })).toBe(false);
        expect(matchesRoomFileSearchEvent(file, "files", "report", { ...filters, type: "m.audio" })).toBe(false);
        expect(matchesRoomFileSearchEvent(file, "files", "report", { ...filters, toDate: "2026-03-07" })).toBe(false);
    });

    it("should reject non-message, redacted and edited-away attachments", () => {
        const file = new MatrixEvent({ type: "m.room.message", content: { msgtype: "m.file", body: "report" } });
        const edited = new MatrixEvent({ ...file.event, content: { msgtype: "m.text", body: "report" } });
        const unrelated = new MatrixEvent({ type: "m.room.member", content: { msgtype: "m.file", body: "report" } });
        expect(matchesRoomFileSearchEvent(file, "files", "report")).toBe(true);
        expect(matchesRoomFileSearchEvent(edited, "files", "report")).toBe(false);
        expect(matchesRoomFileSearchEvent(unrelated, "files", "report")).toBe(false);
    });
});
