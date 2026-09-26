/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import type { RoomFileSearchViewModel } from "../viewmodels/search/RoomFileSearchViewModel";

/** Bridges SDK timeline and decryption updates into the current attachment result query. */
export class RoomFileLiveEvents {
    private readonly decrypting = new Map<string, number>();
    private generation = 0;
    private disposed = false;

    public constructor(
        private readonly client: MatrixClient,
        private readonly results: RoomFileSearchViewModel,
        private roomId: string,
    ) {
        client.on(RoomEvent.Timeline, this.onTimeline);
        client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    }

    /** Drop pending events from the old room or query. */
    public reset = (roomId: string): void => {
        this.roomId = roomId;
        this.generation++;
        this.decrypting.clear();
    };

    private onTimeline = (
        event: MatrixEvent,
        room: Room | undefined,
        toStart: boolean | undefined,
        _removed: boolean,
        data: { liveEvent?: boolean } | undefined,
    ): void => {
        if (this.disposed || room?.roomId !== this.roomId || toStart || !data?.liveEvent) return;
        const id = event.getId();
        if (!id) return;
        const generation = this.generation;
        if (event.isBeingDecrypted()) {
            this.decrypting.set(id, generation);
        } else {
            void this.client
                .decryptEventIfNeeded(event)
                .then(() => {
                    if (
                        !this.disposed &&
                        generation === this.generation &&
                        room.roomId === this.roomId &&
                        !event.isBeingDecrypted() &&
                        !event.isDecryptionFailure()
                    ) {
                        this.applyDecodedEvent(event);
                    }
                })
                .catch(() => {
                    // Failed decryption cannot be projected as a readable attachment.
                });
        }
    };

    private onDecrypted = (event: MatrixEvent, error?: Error): void => {
        const id = event.getId() ?? "";
        if (this.disposed || event.getRoomId() !== this.roomId || this.decrypting.get(id) !== this.generation) return;
        this.decrypting.delete(id);
        if (!error && !event.isDecryptionFailure()) this.applyDecodedEvent(event);
    };

    /** Accept an already-decrypted live event from a caller without installing another listener. */
    public addLiveEvent = (event: MatrixEvent): void => {
        if (!this.disposed && !event.isDecryptionFailure()) this.applyDecodedEvent(event);
    };

    private applyDecodedEvent(event: MatrixEvent): void {
        if (this.disposed || event.getRoomId() !== this.roomId) return;
        if (event.isRedaction()) {
            this.results.redactEvent(event.getAssociatedId());
            return;
        }
        if (event.isRedacted()) return;
        const content = event.getContent();
        if (content["m.relates_to"]?.rel_type === "m.replace") {
            const target = event.getAssociatedId();
            const replacement = content["m.new_content"];
            // The session validates the author against the original, including when a page is pending.
            if (target && replacement && typeof replacement === "object") {
                this.results.replaceEvent(target, replacement, event);
            }
            return;
        }
        this.results.addLiveEvent(event);
    }

    public dispose = (): void => {
        this.disposed = true;
        this.generation++;
        this.decrypting.clear();
        this.client.removeListener(RoomEvent.Timeline, this.onTimeline);
        this.client.removeListener(MatrixEventEvent.Decrypted, this.onDecrypted);
    };
}
