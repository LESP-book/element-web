/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { MatrixEvent, RoomEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { RoomFileLiveEvents } from "./RoomFileLiveEvents";
import type { RoomFileSearchViewModel } from "../viewmodels/search/RoomFileSearchViewModel";

const roomId = "!room:test";
const makeEvent = (
    id: string,
    sender = "@alice:test",
    content: Record<string, unknown> = { msgtype: "m.image", body: "photo" },
): MatrixEvent =>
    new MatrixEvent({ event_id: id, room_id: roomId, sender, type: "m.room.message", origin_server_ts: 1, content });

function makeClient(decrypt: (event: MatrixEvent) => Promise<void>): {
    client: MatrixClient;
    sendTimeline: (event: MatrixEvent) => void;
} {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const client = {
        on: (name: string, listener: (...args: unknown[]) => void): void => {
            listeners.set(name, listener);
        },
        removeListener: (name: string): void => {
            listeners.delete(name);
        },
        decryptEventIfNeeded: decrypt,
    } as unknown as MatrixClient;
    return {
        client,
        sendTimeline: (event) =>
            listeners.get(RoomEvent.Timeline)?.(event, { roomId } as Room, false, false, { liveEvent: true }),
    };
}

describe("RoomFileLiveEvents", () => {
    it("does not deliver a decrypted event from an earlier query in the same room", async () => {
        const pending = Promise.withResolvers<void>();
        const { client, sendTimeline } = makeClient(() => pending.promise);
        const results = {
            addLiveEvent: vi.fn(),
            getEvent: vi.fn(),
            replaceEvent: vi.fn(),
            redactEvent: vi.fn(),
        } as unknown as RoomFileSearchViewModel;
        const adapter = new RoomFileLiveEvents(client, results, roomId);
        sendTimeline(makeEvent("$old"));
        adapter.reset(roomId);
        pending.resolve();
        await pending.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(results.addLiveEvent).not.toHaveBeenCalled();
        adapter.dispose();
    });

    it("routes decoded edits and redactions without projecting them as media", () => {
        const { client } = makeClient(async () => {});
        const original = makeEvent("$original");
        const results = {
            addLiveEvent: vi.fn(),
            getEvent: vi.fn().mockReturnValue(original),
            replaceEvent: vi.fn(),
            redactEvent: vi.fn(),
        } as unknown as RoomFileSearchViewModel;
        const adapter = new RoomFileLiveEvents(client, results, roomId);
        const edit = makeEvent("$edit", "@alice:test", {
            "msgtype": "m.image",
            "body": "edited",
            "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
            "m.new_content": { msgtype: "m.image", body: "edited" },
        });
        adapter.addLiveEvent(edit);
        expect(results.replaceEvent).toHaveBeenCalledWith("$original", { msgtype: "m.image", body: "edited" }, edit);
        adapter.addLiveEvent(makeEvent("$invalid", "@bob:test", edit.getContent()));
        // The result owner checks authorship once the target arrives, even for a pending page.
        expect(results.replaceEvent).toHaveBeenCalledTimes(2);
        const redaction = new MatrixEvent({
            event_id: "$redaction",
            room_id: roomId,
            type: "m.room.redaction",
            redacts: "$original",
        });
        adapter.addLiveEvent(redaction);
        expect(results.redactEvent).toHaveBeenCalledWith("$original");
        adapter.addLiveEvent(
            new MatrixEvent({
                event_id: "$withdraw-edit",
                room_id: roomId,
                type: "m.room.redaction",
                redacts: "$edit",
            }),
        );
        expect(results.redactEvent).toHaveBeenCalledWith("$edit");
        expect(results.addLiveEvent).not.toHaveBeenCalled();
        adapter.dispose();
    });
});
