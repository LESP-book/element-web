/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import {
    RoomMember,
    type Room,
    RoomEvent,
    type RoomState,
    RoomStateEvent,
    MatrixEvent,
    Direction,
    EventTimeline,
    type EventTimelineSet,
    type IRoomTimelineData,
    EventType,
    ClientEvent,
    type MatrixClient,
    HTTPError,
    type IEventWithRoomId,
    type IMatrixProfile,
    type IResultRoomEvents,
    type SyncStateData,
    SyncState,
    type TimelineIndex,
    type TimelineWindow,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";

import PlatformPeg from "../PlatformPeg";
import { MatrixClientPeg } from "../MatrixClientPeg";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActiveRoomChangedPayload } from "../dispatcher/payloads/ActiveRoomChangedPayload";
import type BaseEventIndexManager from "./BaseEventIndexManager";
import {
    type ICrawlerCheckpoint,
    type IEventAndProfile,
    type IFileQuery,
    type IIndexStats,
    type ILoadArgs,
    type ISearchArgs,
} from "./BaseEventIndexManager";
import { asyncFilter } from "../utils/arrays.ts";
import { logErrorAndShowErrorDialog } from "../utils/ErrorUtils.tsx";
import { WebEventIndexError } from "./web/WebEventIndexError";
import { rememberOriginalFileEvent } from "../search/RoomFileSearchOriginals";

// The time in ms that the crawler will wait loop iterations if there
// have not been any checkpoints to consume in the last iteration.
const CRAWLER_IDLE_TIME = 5000;

// The maximum number of events our crawler should fetch in a single crawl.
const EVENTS_PER_CRAWL = 100;

interface ICrawler {
    cancel(): void;
}

/** Outcome of one shared room history request; scanned is not a completeness claim. */
export interface IBackfillResult {
    exhausted: boolean;
    scanned: number;
    indexed: number;
    /** Whether the shared room-history owner has another safe continuation after this step. */
    canContinue: boolean;
    reason?: "end" | "forbidden" | "missing_token" | "stalled";
    error?: unknown;
}

/**
 * Event indexing class that wraps the platform specific event indexing.
 */
export default class EventIndex extends EventEmitter {
    private crawler: ICrawler | null = null;
    private crawlerPromise: Promise<void> | null = null;
    private activeRoomId: string | null = null;
    private activeRoomChangedDispatchToken: string | undefined;

    /**
     * A list of checkpoints which are awaiting processing by the crawler, once it has done with `currentCheckpoint`.
     */
    private crawlerCheckpoints: ICrawlerCheckpoint[] = [];

    /**
     * The current checkpoint that the crawler is working on.
     */
    private currentCheckpoint: ICrawlerCheckpoint | null = null;
    private readonly roomTasks = new Map<string, Promise<IBackfillResult>>();
    private readonly pendingCheckpointUpdates = new Map<string, Promise<void>>();
    private readonly completedRoomTokens = new Map<string, string | null>();
    // Only the backward chain currently owned by a per-room step.
    private readonly inFlightRoomTokens = new Map<string, string>();
    private closed = false;
    private indexClient: MatrixClient | null = null;
    private indexManager: BaseEventIndexManager | null = null;
    // Flag to force adding initial checkpoints (e.g., after database recreation)
    private forceAddInitialCheckpoints = false;

    /**
     * True if we need to add the initial checkpoints for encrypted rooms, once we've completed a sync.
     * This is set if the database is empty when the indexer is first initialized.
     */
    private needsInitialCheckpoints = false;

    private readonly logger;

    public constructor() {
        super();

        this.logger = logger.getChild("EventIndex");
    }

    private isWebPlatform(): boolean {
        return Boolean(this.indexManager?.supportsLocalUnencryptedRoomSearch());
    }

    private activeManager(): BaseEventIndexManager | null {
        return !this.closed && MatrixClientPeg.get() === this.indexClient ? this.indexManager : null;
    }

    /**
     * Web 端对齐 FluffyChat：只在“用户正在查看的房间”按需建立索引。
     * 也就是说：不做跨房间的后台索引/预抓取，避免资源占用与隐私暴露面扩大。
     */
    private shouldIndexRoom(roomId: string): boolean {
        if (!this.isWebPlatform()) return true;
        return Boolean(this.activeRoomId) && this.activeRoomId === roomId;
    }

    public async init(): Promise<void> {
        const indexManager = PlatformPeg.get()?.getEventIndexingManager();
        if (!indexManager) return;
        this.indexClient = MatrixClientPeg.safeGet();
        this.indexManager = indexManager;

        // If the index is empty, set a flag so that we add the initial checkpoints once we sync.
        // We do this check here rather than in `onSync` because, by the time `onSync` is called, there will
        // have been a few events added to the index.
        if (!this.isWebPlatform() && (await indexManager.isEventIndexEmpty())) {
            this.needsInitialCheckpoints = true;
        }

        this.crawlerCheckpoints = await indexManager.loadCheckpoints();
        this.logger.debug("Loaded checkpoints", JSON.stringify(this.crawlerCheckpoints));

        this.registerActiveRoomChangedListener();
        this.registerListeners();
    }

    /**
     * Mark that initial checkpoints should be added on next sync.
     * This is used when the database is recreated (e.g., schema change).
     */
    public setForceAddInitialCheckpoints(force: boolean): void {
        this.forceAddInitialCheckpoints = force;
    }

    /**
     * Register event listeners that are necessary for the event index to work.
     */
    public registerListeners(): void {
        const client = MatrixClientPeg.safeGet();

        client.on(ClientEvent.Sync, this.onSync);
        client.on(RoomEvent.Timeline, this.onRoomTimeline);
        client.on(RoomEvent.TimelineReset, this.onTimelineReset);
        client.on(RoomStateEvent.Events, this.onRoomStateEvent);
    }

    private registerActiveRoomChangedListener(): void {
        if (this.activeRoomChangedDispatchToken) return;
        this.activeRoomChangedDispatchToken = defaultDispatcher.register(this.onDispatch);
    }

    private removeActiveRoomChangedListener(): void {
        if (!this.activeRoomChangedDispatchToken) return;
        defaultDispatcher.unregister(this.activeRoomChangedDispatchToken);
        this.activeRoomChangedDispatchToken = undefined;
    }

    private onDispatch = (payload: { action?: string }): void => {
        if (payload.action !== Action.ActiveRoomChanged) return;
        const { newRoomId } = payload as ActiveRoomChangedPayload;
        this.activeRoomId = newRoomId;
    };

    /**
     * Remove the event index specific event listeners.
     */
    public removeListeners(): void {
        const client = this.indexClient;
        if (client === null) return;

        client.removeListener(ClientEvent.Sync, this.onSync);
        client.removeListener(RoomEvent.Timeline, this.onRoomTimeline);
        client.removeListener(RoomEvent.TimelineReset, this.onTimelineReset);
        client.removeListener(RoomStateEvent.Events, this.onRoomStateEvent);
    }

    /**
     * Add crawler checkpoints for all of the encrypted rooms the user is in.
     */
    public async addInitialCheckpoints(): Promise<void> {
        this.needsInitialCheckpoints = false;

        const indexManager = this.activeManager();
        if (!indexManager) return;
        const client = MatrixClientPeg.safeGet();
        const rooms = client.getRooms();
        // Pin the first-sync boundary before checking room encryption asynchronously.
        const snapshots = new Map(rooms.map((room) => [room.roomId, this.captureRoomTimeline(room.roomId)]));
        const inFlightAtSync = new Map(this.inFlightRoomTokens);
        const stepsAtSync = new Map(this.roomTasks);
        const pendingAtSync = new Set(this.pendingCheckpointUpdates.keys());

        // We only care to crawl the encrypted rooms, non-encrypted
        // rooms can use the search provided by the homeserver.
        const encryptedRooms = await asyncFilter(rooms, async (room) =>
            Boolean(await client.getCrypto()?.isEncryptionEnabledInRoom(room.roomId)),
        );
        if (
            this.closed ||
            client !== this.indexClient ||
            MatrixClientPeg.get() !== client ||
            this.activeManager() !== indexManager
        ) {
            return;
        }

        this.logger.debug("addInitialCheckpoints: starting");

        // Capture each room's current gap and enqueue both directions behind any room step.
        await Promise.all(
            encryptedRooms.map(async (room): Promise<void> => {
                if (
                    this.closed ||
                    client !== this.indexClient ||
                    MatrixClientPeg.get() !== client ||
                    this.activeManager() !== indexManager
                ) {
                    return;
                }
                const snapshot = snapshots.get(room.roomId);
                if (!snapshot?.token) return;
                const coveredStep =
                    !pendingAtSync.has(room.roomId) && inFlightAtSync.get(room.roomId) === snapshot.token
                        ? stepsAtSync.get(room.roomId)
                        : undefined;
                try {
                    await this.enqueueRoomCheckpoint(room.roomId, this.shouldFullCrawl(), snapshot, true, coveredStep);
                } catch (error) {
                    this.logger.warn("Error adding initial room checkpoints", room.roomId, error);
                }
            }),
        );
        this.logger.debug("addInitialCheckpoints: done");
    }

    /**
     * The sync event listener.
     */
    private onSync = (state: SyncState, prevState: SyncState | null, data?: SyncStateData): void => {
        if (state != SyncState.Syncing) return;

        const onSyncInner = async (): Promise<void> => {
            const indexManager = this.activeManager();
            if (!indexManager) return;

            // If the index was empty when we first started up, add the initial checkpoints, to back-populate the index.
            // Also check forceAddInitialCheckpoints flag (used when database is recreated, e.g., schema change)
            if (this.needsInitialCheckpoints || this.forceAddInitialCheckpoints) {
                await this.addInitialCheckpoints();
                this.forceAddInitialCheckpoints = false;
            }

            // Web 端不做全量后台爬取：仅在用户“搜索更多”等按需触发时回溯，避免启动时大量索引占用资源。
            if (!this.isWebPlatform()) {
                // Start the crawler if it's not already running.
                this.startCrawler();
            }

            // Commit queued events only while this instance still owns the account.
            if (this.activeManager()) await indexManager.commitLiveEvents();
        };

        onSyncInner().catch((e) => {
            logErrorAndShowErrorDialog("Event indexer threw an unexpected error", e);
        });
    };

    private shouldFullCrawl(): boolean {
        return !this.isWebPlatform();
    }

    /*
     * The Room.timeline listener.
     *
     * This listener waits for live events in encrypted rooms, if they are
     * decrypted or unencrypted we queue them to be added to the index,
     * otherwise we save their event id and wait for them in the Event.decrypted
     * listener.
     */
    private onRoomTimeline = async (
        ev: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
        data: IRoomTimelineData,
    ): Promise<void> => {
        if (!room || !this.activeManager()) return; // notification timeline or obsolete client

        const client = MatrixClientPeg.safeGet();

        const roomId = ev.getRoomId()!;
        // Redactions and replacements may refer to cached events from rooms no longer active.
        if (ev.isRedaction()) return this.redactEvent(ev);
        if (this.isWebPlatform() && (await this.applyEditIfNeeded(ev))) return;
        if (!this.shouldIndexRoom(roomId) || this.closed) return;
        // Web 端：所有房间都走本地索引；其它平台保持原逻辑（仅加密房间本地索引）。
        if (!this.isWebPlatform() && !client.isRoomEncrypted(roomId)) return;

        // If it isn't a live event or if it's redacted there's nothing to do.
        if (toStartOfTimeline || !data || !data.liveEvent || ev.isRedacted()) {
            return;
        }

        await client.decryptEventIfNeeded(ev);

        await this.addLiveEventToIndex(ev);
    };

    private onRoomStateEvent = async (ev: MatrixEvent, state: RoomState): Promise<void> => {
        if (!this.activeManager() || this.isWebPlatform()) return;
        if (!MatrixClientPeg.safeGet().isRoomEncrypted(state.roomId)) return;

        if (ev.getType() === EventType.RoomEncryption && !(await this.isRoomIndexed(state.roomId))) {
            this.logger.debug("Adding a checkpoint for a newly encrypted room", state.roomId);
            await this.enqueueRoomCheckpoint(state.roomId, true, this.captureRoomTimeline(state.roomId));
        }
    };

    /*
     * Removes a redacted event from our event index.
     * We cannot rely on Room.redaction as this only fires if the redaction applied to an event the js-sdk has loaded.
     */
    private redactEvent = async (ev: MatrixEvent): Promise<void> => {
        const indexManager = this.activeManager();
        if (!indexManager) return;

        const associatedId = ev.getAssociatedId();
        if (!associatedId) return;

        try {
            await indexManager.deleteEvent(associatedId);
        } catch (e) {
            this.logger.warn("Error deleting event from index", e);
        }
    };

    /*
     * The Room.timelineReset listener.
     *
     * Listens for timeline resets that are caused by a limited timeline to
     * re-add checkpoints for rooms that need to be crawled again.
     */
    private onTimelineReset = async (room: Room | undefined): Promise<void> => {
        if (!room || !this.activeManager()) return;
        if (this.isWebPlatform()) return;
        if (!MatrixClientPeg.safeGet().isRoomEncrypted(room.roomId)) return;

        this.logger.debug("Adding a checkpoint because of a limited timeline", room.roomId);

        await this.enqueueRoomCheckpoint(room.roomId, false, this.captureRoomTimeline(room.roomId));
    };

    /**
     * Check if an event should be added to the event index.
     *
     * Most notably we filter events for which decryption failed, are redacted
     * or aren't of a type that we know how to index.
     *
     * @param {MatrixEvent} ev The event that should be checked.
     * @returns {bool} Returns true if the event can be indexed, false
     * otherwise.
     */
    private isValidEvent(this: void, ev: MatrixEvent): boolean {
        const isUsefulType = [EventType.RoomMessage, EventType.RoomName, EventType.RoomTopic].includes(
            ev.getType() as EventType,
        );
        const validEventType = isUsefulType && !ev.isRedacted() && !ev.isDecryptionFailure();

        let validMsgType = true;
        let hasContentValue = true;

        if (ev.getType() === EventType.RoomMessage && !ev.isRedacted()) {
            // Expand this if there are more invalid msgtypes.
            const msgtype = ev.getContent().msgtype;

            if (!msgtype) validMsgType = false;
            else validMsgType = !msgtype.startsWith("m.key.verification");

            if (!ev.getContent().body) hasContentValue = false;
        } else if (ev.getType() === EventType.RoomTopic && !ev.isRedacted()) {
            if (!ev.getContent().topic) hasContentValue = false;
        } else if (ev.getType() === EventType.RoomName && !ev.isRedacted()) {
            if (!ev.getContent().name) hasContentValue = false;
        }

        return validEventType && validMsgType && hasContentValue;
    }

    private eventToJson(ev: MatrixEvent): IEventWithRoomId {
        // getEffectiveEvent merges the SDK clear event so the index can retain a searchable unedited source.
        const e = ev.getEffectiveEvent() as any;

        if (ev.isEncrypted()) {
            // Let us store some additional data so we can re-verify the event.
            // The js-sdk checks if an event is encrypted using the algorithm,
            // the sender key and ed25519 signing key are used to find the
            // correct device that sent the event which allows us to check the
            // verification state of the event, either directly or using cross
            // signing.
            e.curve25519Key = ev.getSenderKey();
            e.ed25519Key = ev.getClaimedEd25519Key();
            e.algorithm = ev.getWireContent().algorithm;
            e.forwardingCurve25519KeyChain = ev.getForwardingCurve25519KeyChain();
        } else {
            // Make sure that unencrypted events don't contain any of that data,
            // despite what the server might give to us.
            delete e.curve25519Key;
            delete e.ed25519Key;
            delete e.algorithm;
            delete e.forwardingCurve25519KeyChain;
        }

        return e;
    }

    /**
     * Queue up live events to be added to the event index.
     *
     * @param {MatrixEvent} ev The event that should be added to the index.
     */
    private async addLiveEventToIndex(ev: MatrixEvent): Promise<void> {
        const indexManager = this.activeManager();
        if (this.isWebPlatform() && (await this.applyEditIfNeeded(ev))) return;
        if (!indexManager || !this.activeManager() || !this.isValidEvent(ev)) return;

        const e = this.eventToJson(ev);

        const profile = {
            displayname: ev.sender?.rawDisplayName,
            avatar_url: ev.sender?.getMxcAvatarUrl(),
        };

        await indexManager.addEventToIndex(e, profile);
    }

    /**
     * Emmit that the crawler has changed the checkpoint that it's currently
     * handling.
     */
    private emitNewCheckpoint(): void {
        this.emit("changedCheckpoint", this.currentRoom());
    }

    private async applyEditIfNeeded(ev: MatrixEvent): Promise<boolean> {
        if (ev.getType() !== EventType.RoomMessage || ev.isDecryptionFailure()) return false;
        const content = ev.getContent();
        const relation = content["m.relates_to"];
        if (relation?.rel_type !== "m.replace") return false;
        await this.activeManager()?.applyEventEdit(ev.getEffectiveEvent() as IEventWithRoomId);
        return true;
    }

    private async addEventsFromLiveTimeline(events: MatrixEvent[]): Promise<void> {
        const client = MatrixClientPeg.safeGet();
        for (const ev of events) {
            if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Index account changed");
            if (ev.isRedaction()) {
                await this.redactEvent(ev);
            } else {
                await client.decryptEventIfNeeded(ev);
                if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Index account changed");
                await this.addLiveEventToIndex(ev);
            }
        }
    }

    /** Import the visible timeline before the first local room query; history begins at its backward token. */
    public async ensureRoomTimelineIndexed(roomId: string): Promise<void> {
        if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Index account changed");
        const snapshot = this.captureRoomTimeline(roomId);
        if (snapshot) await this.addEventsFromLiveTimeline(snapshot.events);
    }

    private captureRoomTimeline(roomId: string): { token: string | null; events: MatrixEvent[] } | null {
        const timeline = MatrixClientPeg.safeGet().getRoom(roomId)?.getLiveTimeline();
        return timeline
            ? { token: timeline.getPaginationToken(Direction.Backward), events: [...timeline.getEvents()] }
            : null;
    }

    // A limited timeline can introduce a second gap while a crawl is in flight. Capture its
    // token now: a later reset must not replace the first gap while it waits in this queue.
    private async enqueueRoomCheckpoint(
        roomId: string,
        fullCrawl: boolean,
        snapshot: { token: string | null; events: MatrixEvent[] } | null,
        includeForward = false,
        coveredAtCapture?: Promise<IBackfillResult>,
    ): Promise<void> {
        const client = this.indexClient;
        const indexManager = this.indexManager;
        const previous = this.pendingCheckpointUpdates.get(roomId);
        const isStillActive = (): boolean =>
            Boolean(client) &&
            !this.closed &&
            this.indexClient === client &&
            MatrixClientPeg.get() === client &&
            this.activeManager() === indexManager;
        const update = (previous ?? Promise.resolve())
            .catch(() => {})
            .then(async () => {
                while (this.roomTasks.has(roomId)) await this.roomTasks.get(roomId);
                if (!isStillActive()) return;
                const coveredResult = await coveredAtCapture;
                if (!isStillActive()) return;
                // The initial-sync update itself keeps pendingCheckpointUpdates set while the
                // foreground step ends. Ignore only that update, never another queued gap.
                const skipInitialBackward =
                    includeForward &&
                    !previous &&
                    coveredResult?.reason === "end" &&
                    !coveredResult.error &&
                    this.pendingCheckpointUpdates.get(roomId) === update &&
                    !this.crawlerCheckpoints.some(
                        (item) => item.roomId === roomId && item.direction === Direction.Backward,
                    );
                await this.runRoomTask(roomId, async () => {
                    if (!isStillActive()) return { exhausted: false, scanned: 0, indexed: 0, canContinue: false };
                    if (
                        !skipInitialBackward &&
                        (!includeForward ||
                            !snapshot?.token ||
                            (await this.getCompletedRoomToken(roomId)) !== snapshot.token)
                    ) {
                        await this.addRoomCheckpoint(roomId, fullCrawl, snapshot);
                    }
                    if (includeForward) await this.addRoomCheckpoint(roomId, false, snapshot, Direction.Forward);
                    const hasBackwardGap = this.crawlerCheckpoints.some(
                        (checkpoint) => checkpoint.roomId === roomId && checkpoint.direction === Direction.Backward,
                    );
                    return { exhausted: false, scanned: 0, indexed: 0, canContinue: hasBackwardGap };
                });
            });
        this.pendingCheckpointUpdates.set(roomId, update);
        try {
            await update;
        } finally {
            if (this.pendingCheckpointUpdates.get(roomId) === update) this.pendingCheckpointUpdates.delete(roomId);
        }
    }

    private async addRoomCheckpoint(
        roomId: string,
        fullCrawl = false,
        snapshot = this.captureRoomTimeline(roomId),
        direction = Direction.Backward,
    ): Promise<void> {
        const indexManager = this.activeManager();
        if (!indexManager || !snapshot) return;
        const { token, events } = snapshot;
        // The backward token starts before the captured timeline; forward preserves
        // desktop crawler semantics without importing the same events twice.
        if (direction === Direction.Backward) await this.addEventsFromLiveTimeline(events);
        if (!token || this.activeManager() !== indexManager) return;

        const checkpoint = {
            roomId,
            token: token,
            ...(direction === Direction.Backward
                ? {
                      fullCrawl: fullCrawl && this.shouldFullCrawl(),
                      ...(this.isWebPlatform() ? { rootToken: token } : {}),
                  }
                : {}),
            direction,
        };

        if (
            this.crawlerCheckpoints.some(
                (item) => item.roomId === roomId && item.token === token && item.direction === direction,
            )
        )
            return;
        this.logger.debug("Adding checkpoint", JSON.stringify(checkpoint));

        await indexManager.addCrawlerCheckpoint(checkpoint);
        if (this.activeManager() !== indexManager) return;
        this.crawlerCheckpoints.push(checkpoint);
    }

    private takeRoomCheckpoint(roomId: string, direction: Direction): ICrawlerCheckpoint | null {
        const index = this.crawlerCheckpoints.findIndex(
            (checkpoint) => checkpoint.roomId === roomId && checkpoint.direction === direction,
        );
        if (index === -1) return null;
        return this.crawlerCheckpoints.splice(index, 1)[0] ?? null;
    }

    private async crawlCheckpoint(
        checkpoint: ICrawlerCheckpoint,
        limit: number,
    ): Promise<{
        nextCheckpoint: ICrawlerCheckpoint | null;
        scanned: number;
        indexed: number;
        reason?: IBackfillResult["reason"];
        error?: unknown;
    }> {
        const client = MatrixClientPeg.safeGet();
        const indexManager = this.activeManager();
        if (!indexManager) {
            throw new Error("Event indexing is not supported on this platform");
        }

        const rootToken =
            checkpoint.rootToken ??
            (this.captureRoomTimeline(checkpoint.roomId)?.token === checkpoint.token ? checkpoint.token : undefined);
        const eventMapper = client.getEventMapper({ preventReEmit: true });
        let res: Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>;

        try {
            res = await client.createMessagesRequest(checkpoint.roomId, checkpoint.token, limit, checkpoint.direction);
        } catch (error) {
            if (error instanceof HTTPError && error.httpStatus === 403 && this.activeManager() === indexManager) {
                this.logger.debug("Removing checkpoint because history is not accessible.");
                await indexManager.removeCrawlerCheckpoint(checkpoint);
                return { nextCheckpoint: null, scanned: 0, indexed: 0, reason: "forbidden" };
            }
            if (error instanceof HTTPError && error.httpStatus === 400) {
                throw new WebEventIndexError({
                    code: "cursor_unavailable",
                    operation: "backfill",
                    retryability: "reinitialize",
                });
            }
            if (
                error instanceof HTTPError &&
                typeof error.httpStatus === "number" &&
                error.httpStatus >= 400 &&
                error.httpStatus < 500
            ) {
                throw new WebEventIndexError({
                    code: "permission_denied",
                    operation: "backfill",
                    retryability: "user_action",
                });
            }
            throw new WebEventIndexError({
                code: "network_failure",
                operation: "backfill",
                retryability: "retry",
            });
        }

        if (!this.activeManager() || client !== this.indexClient)
            throw new Error("Index account changed during backfill");
        if (res.chunk.length === 0) {
            this.logger.debug("Done with the checkpoint", JSON.stringify(checkpoint));
            await indexManager.removeCrawlerCheckpoint(checkpoint);
            return { nextCheckpoint: null, scanned: 0, indexed: 0, reason: "end" };
        }

        const matrixEvents = res.chunk.map(eventMapper);
        let stateEvents: MatrixEvent[] = [];
        if (res.state !== undefined) {
            stateEvents = res.state.map(eventMapper);
        }

        const profiles: Record<string, IMatrixProfile> = {};

        stateEvents.forEach((ev) => {
            if (ev.getContent().membership === KnownMembership.Join) {
                profiles[ev.getSender()!] = {
                    displayname: ev.getContent().displayname,
                    avatar_url: ev.getContent().avatar_url,
                };
            }
        });

        const decryptionPromises = matrixEvents
            .filter((event) => event.isEncrypted())
            .map((event) => client.decryptEventIfNeeded(event, { emit: false }));

        await Promise.all(decryptionPromises);
        if (!this.activeManager() || client !== this.indexClient)
            throw new Error("Index account changed during backfill");

        if (this.isWebPlatform()) {
            for (const event of matrixEvents) await this.applyEditIfNeeded(event);
        }
        const filteredEvents = matrixEvents.filter(
            (ev) =>
                this.isValidEvent(ev) &&
                (!this.isWebPlatform() || ev.getContent()["m.relates_to"]?.rel_type !== "m.replace"),
        );
        const redactionEvents = matrixEvents.filter((ev) => ev.isRedaction());

        const events = filteredEvents.map((ev) => {
            const e = this.eventToJson(ev);

            let profile: IMatrixProfile = {};
            if (e.sender in profiles) profile = profiles[e.sender];
            return { event: e, profile };
        });

        let newCheckpoint: ICrawlerCheckpoint | null = null;
        if (res.end) {
            newCheckpoint = {
                roomId: checkpoint.roomId,
                token: res.end,
                fullCrawl: checkpoint.fullCrawl,
                rootToken,
                direction: checkpoint.direction,
            };
        }

        for (const ev of redactionEvents) {
            const eventId = ev.getAssociatedId();
            if (eventId) {
                await indexManager.deleteEvent(eventId);
            } else {
                this.logger.warn("Redaction event doesn't contain a valid associated event id", ev);
            }
        }

        let eventsAlreadyAdded = await indexManager.addHistoricEvents(events, newCheckpoint, checkpoint);
        if (events.length === 0) {
            // Don't stop crawling just because this batch didn't contain indexable events.
            eventsAlreadyAdded = false;
        }

        if (!newCheckpoint) {
            this.logger.debug(
                "The server didn't return a valid new checkpoint, not continuing the crawl.",
                JSON.stringify(checkpoint),
            );
            return {
                nextCheckpoint: null,
                scanned: res.chunk.length,
                indexed: eventsAlreadyAdded ? 0 : events.length,
                reason: "missing_token",
                error: new WebEventIndexError({
                    code: "cursor_unavailable",
                    operation: "backfill",
                    retryability: "reinitialize",
                }),
            };
        }

        // Keep newly indexed events, but do not request the same server cursor again.
        if (newCheckpoint.token === checkpoint.token) {
            this.logger.debug("Checkpoint did not advance, stopping the crawl", JSON.stringify(checkpoint));
            await indexManager.removeCrawlerCheckpoint(newCheckpoint);
            return {
                nextCheckpoint: null,
                scanned: res.chunk.length,
                indexed: eventsAlreadyAdded ? 0 : events.length,
                reason: "stalled",
            };
        }

        if (eventsAlreadyAdded === true) {
            this.logger.debug(
                "Checkpoint had no new events inserted, continuing the crawl",
                JSON.stringify(checkpoint),
            );
        }

        return {
            nextCheckpoint: newCheckpoint,
            scanned: res.chunk.length,
            indexed: eventsAlreadyAdded ? 0 : events.length,
        };
    }

    /**
     * The main crawler loop.
     *
     * Goes through crawlerCheckpoints and fetches events from the server to be
     * added to the EventIndex.
     *
     * If a /room/{roomId}/messages request doesn't contain any events, stop the
     * crawl, otherwise create a new checkpoint and push it to the
     * crawlerCheckpoints queue, so we go through them in a round-robin way.
     */
    private async crawlerFunc(): Promise<void> {
        let cancelled = false;
        let wake: (() => void) | null = null;

        const indexManager = this.activeManager();
        if (!indexManager) return;

        this.crawler = {
            cancel: () => {
                cancelled = true;
                wake?.();
            },
        };

        let idle = false;

        // oxlint-disable-next-line no-unmodified-loop-condition
        while (!cancelled && !this.closed) {
            let sleepTime = SettingsStore.getValueAt(SettingLevel.DEVICE, "crawlerSleepTime");

            // Don't let the user configure a lower sleep time than 100 ms.
            sleepTime = Math.max(sleepTime, 100);

            if (idle) {
                sleepTime = CRAWLER_IDLE_TIME;
            }

            if (this.currentCheckpoint !== null) {
                this.currentCheckpoint = null;
                this.emitNewCheckpoint();
            }

            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    wake = null;
                    resolve();
                }, sleepTime);
                wake = () => {
                    clearTimeout(timer);
                    wake = null;
                    resolve();
                };
            });

            if (cancelled || this.closed) break;

            // The shared room step owns dequeue and requeue, including checkpoint persistence.
            const checkpoint = this.crawlerCheckpoints.find((item) => !this.roomTasks.has(item.roomId));

            /// There is no checkpoint available currently, one may appear if
            // a sync with limited room timelines happens, so go back to sleep.
            if (checkpoint === undefined) {
                idle = true;
                continue;
            }

            this.logger.debug(`Processing checkpoint ${JSON.stringify(checkpoint)}`);
            this.currentCheckpoint = checkpoint;
            this.emitNewCheckpoint();

            idle = false;

            try {
                await this.runRoomTask(checkpoint.roomId, () =>
                    this.processRoomStep(checkpoint.roomId, EVENTS_PER_CRAWL, checkpoint.direction, false),
                );
            } catch (e) {
                this.logger.warn("Error during a crawl", e);
            }
        }
    }

    /**
     * Start the crawler background task.
     */
    public startCrawler(): void {
        if (this.closed || this.crawlerPromise) return;
        this.logger.debug("Starting crawler");
        this.crawlerPromise = this.crawlerFunc()
            .catch((e) => {
                this.logger.error("Error in crawler function", e);
            })
            .finally(() => {
                this.crawler = null;
                this.crawlerPromise = null;
            });
    }

    /**
     * Stop the crawler background task.
     */
    public stopCrawler(): void {
        if (this.crawler === null) return;
        this.logger.debug("Stopping crawler");
        this.crawler.cancel();
    }

    /**
     * Close the event index.
     *
     * This removes all the MatrixClient event listeners, stops the crawler
     * task, and closes the index.
     */
    public async close(): Promise<void> {
        const indexManager = this.indexManager;
        this.closed = true;
        this.removeListeners();
        this.removeActiveRoomChangedListener();
        this.stopCrawler();
        await this.crawlerPromise;
        await Promise.allSettled([...this.pendingCheckpointUpdates.values(), ...this.roomTasks.values()]);
        await indexManager?.closeEventIndex();
    }

    /**
     * Search the event index using the given term for matching events.
     *
     * @param {ISearchArgs} searchArgs The search configuration for the search,
     * sets the search term and determines the search result contents.
     *
     * @returns {Promise<IResultRoomEvents[]>} A promise that will resolve to an array
     * of search results once the search is done.
     */
    public async search(searchArgs: ISearchArgs): Promise<IResultRoomEvents | undefined> {
        if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Event index account changed");
        const result = await this.indexManager?.searchEventIndex(searchArgs);
        if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Event index account changed");
        return result;
    }

    public hasBackfillForRoom(roomId: string): boolean {
        if (this.roomTasks.has(roomId)) return true;
        if (this.currentCheckpoint?.roomId === roomId && this.currentCheckpoint.direction === Direction.Backward) {
            return true;
        }
        return this.crawlerCheckpoints.some(
            (checkpoint) => checkpoint.roomId === roomId && checkpoint.direction === Direction.Backward,
        );
    }

    private runRoomTask(roomId: string, task: () => Promise<IBackfillResult>): Promise<IBackfillResult> {
        const running = this.roomTasks.get(roomId);
        if (running) return running;
        const promise = task().finally(() => {
            this.roomTasks.delete(roomId);
            this.inFlightRoomTokens.delete(roomId);
        });
        this.roomTasks.set(roomId, promise);
        return promise;
    }

    /** Fetch one shared room-history page. Concurrent callers join the same per-room step. */
    public backfillRoom(roomId: string, limit = EVENTS_PER_CRAWL): Promise<IBackfillResult> {
        if (this.closed || MatrixClientPeg.get() !== this.indexClient) {
            return Promise.resolve({
                exhausted: false,
                scanned: 0,
                indexed: 0,
                canContinue: false,
                error: new Error("Index account changed"),
            });
        }
        const running = this.roomTasks.get(roomId);
        if (
            running &&
            this.currentCheckpoint?.roomId === roomId &&
            this.currentCheckpoint.direction !== Direction.Backward
        ) {
            return running.then(() => this.backfillRoom(roomId, limit));
        }
        if (running) return running;
        const pending = this.pendingCheckpointUpdates.get(roomId);
        if (pending) return pending.then(() => this.backfillRoom(roomId, limit));
        return this.runRoomTask(roomId, () => this.processRoomStep(roomId, limit, Direction.Backward, true));
    }

    private async getCompletedRoomToken(roomId: string): Promise<string | null> {
        if (this.completedRoomTokens.has(roomId)) return this.completedRoomTokens.get(roomId) ?? null;
        const token = (await this.activeManager()?.getCompletedRoomToken?.(roomId)) ?? null;
        if (!this.activeManager()) throw new Error("Index account changed");
        this.completedRoomTokens.set(roomId, token);
        return token;
    }

    // Own checkpoint retrieval, commit, and requeue in the same per-room task.
    private async processRoomStep(
        roomId: string,
        limit: number,
        direction: Direction,
        create: boolean,
    ): Promise<IBackfillResult> {
        const client = MatrixClientPeg.safeGet();
        if (this.closed || client !== this.indexClient) throw new Error("Index account changed");
        if (create && !this.isWebPlatform() && !client.isRoomEncrypted(roomId)) {
            return { exhausted: true, scanned: 0, indexed: 0, canContinue: false, reason: "end" };
        }
        let checkpoint = this.takeRoomCheckpoint(roomId, direction);
        if (checkpoint && direction === Direction.Backward) {
            const liveToken = this.captureRoomTimeline(roomId)?.token;
            const rootToken = checkpoint.rootToken ?? (checkpoint.token === liveToken ? liveToken : undefined);
            if (rootToken) this.inFlightRoomTokens.set(roomId, rootToken);
        }
        if (!checkpoint && this.pendingCheckpointUpdates.has(roomId)) {
            return { exhausted: false, scanned: 0, indexed: 0, canContinue: true };
        }
        if (!checkpoint && create) {
            try {
                const snapshot = this.captureRoomTimeline(roomId);
                if (snapshot?.token) this.inFlightRoomTokens.set(roomId, snapshot.token);
                if (snapshot?.token && (await this.getCompletedRoomToken(roomId)) === snapshot.token) {
                    return { exhausted: true, scanned: 0, indexed: 0, canContinue: false, reason: "end" };
                }
                if (this.pendingCheckpointUpdates.has(roomId)) {
                    return { exhausted: false, scanned: 0, indexed: 0, canContinue: true };
                }
                await this.addRoomCheckpoint(roomId, false, snapshot);
            } catch (error) {
                return { exhausted: false, scanned: 0, indexed: 0, canContinue: true, error };
            }
            checkpoint = this.takeRoomCheckpoint(roomId, direction);
        }
        if (!checkpoint) {
            const pending = this.pendingCheckpointUpdates.has(roomId);
            return {
                exhausted: !pending,
                scanned: 0,
                indexed: 0,
                canContinue: pending,
                reason: pending ? undefined : "end",
            };
        }
        try {
            const rootToken =
                checkpoint.rootToken ??
                (this.captureRoomTimeline(roomId)?.token === checkpoint.token ? checkpoint.token : undefined);
            if (direction === Direction.Backward && rootToken) this.inFlightRoomTokens.set(roomId, rootToken);
            const result = await this.crawlCheckpoint(checkpoint, limit);
            if (result.nextCheckpoint && !this.closed) this.crawlerCheckpoints.push(result.nextCheckpoint);
            const moreGaps =
                this.crawlerCheckpoints.some(
                    (item) => item.roomId === roomId && item.direction === Direction.Backward,
                ) || this.pendingCheckpointUpdates.has(roomId);
            const currentLiveToken = direction === Direction.Backward ? this.captureRoomTimeline(roomId)?.token : null;
            const sameRoot = rootToken && currentLiveToken === rootToken;
            const changedRoot = Boolean(rootToken && currentLiveToken && currentLiveToken !== rootToken);
            const exhausted = result.reason === "end" && !result.nextCheckpoint && !moreGaps && !changedRoot;
            // Only an actual end of history is durable completion. Missing/stalled cursors
            // may be recoverable; a future reset with the same token must be retried.
            if (exhausted && result.reason === "end" && direction === Direction.Backward && sameRoot) {
                const completionManager = this.activeManager();
                if (!completionManager || client !== this.indexClient) {
                    return {
                        exhausted: false,
                        scanned: result.scanned,
                        indexed: result.indexed,
                        canContinue: false,
                        error: new Error("Index account changed"),
                    };
                }
                try {
                    await completionManager.markRoomHistoryComplete?.(roomId, rootToken);
                    if (this.activeManager() !== completionManager || client !== this.indexClient) {
                        return {
                            exhausted: false,
                            scanned: result.scanned,
                            indexed: result.indexed,
                            canContinue: false,
                            error: new Error("Index account changed"),
                        };
                    }
                    this.completedRoomTokens.set(roomId, rootToken);
                } catch (error) {
                    return {
                        exhausted: false,
                        scanned: result.scanned,
                        indexed: result.indexed,
                        canContinue: false,
                        error: WebEventIndexError.from(error, "markRoomHistoryComplete"),
                    };
                }
            }
            if (result.reason === "missing_token" || result.reason === "stalled") {
                return {
                    exhausted: false,
                    scanned: result.scanned,
                    indexed: result.indexed,
                    reason: result.reason,
                    canContinue: false,
                    error: new WebEventIndexError({
                        code: "cursor_unavailable",
                        operation: "backfill",
                        retryability: "reinitialize",
                    }),
                };
            }
            const canContinue =
                !exhausted &&
                (Boolean(result.nextCheckpoint) ||
                    this.pendingCheckpointUpdates.has(roomId) ||
                    this.crawlerCheckpoints.some(
                        (item) => item.roomId === roomId && item.direction === Direction.Backward,
                    ));
            return {
                exhausted,
                scanned: result.scanned,
                indexed: result.indexed,
                reason: result.reason,
                canContinue,
            };
        } catch (error) {
            const indexError = WebEventIndexError.from(error, "backfill");
            this.logger.warn("Error backfilling room events", roomId, indexError.code);
            if (!this.closed) this.crawlerCheckpoints.push(checkpoint);
            return {
                exhausted: false,
                scanned: 0,
                indexed: 0,
                canContinue: !this.closed,
                error: indexError,
            };
        }
    }

    /**
     * Load events that contain URLs from the event index.
     *
     * @param {Room} room The room for which we should fetch events containing
     * URLs
     *
     * @param {number} limit The maximum number of events to fetch.
     *
     * @param {string} fromEvent From which event should we continue fetching
     * events from the index. This is only needed if we're continuing to fill
     * the timeline, e.g. if we're paginating. This needs to be set to a event
     * id of an event that was previously fetched with this function.
     *
     * @param {string} direction The direction in which we will continue
     * fetching events. EventTimeline.BACKWARDS to continue fetching events that
     * are older than the event given in fromEvent, EventTimeline.FORWARDS to
     * fetch newer events.
     *
     * @returns {Promise<MatrixEvent[]>} Resolves to an array of events that
     * contain URLs.
     */
    public async loadFileEvents(
        room: Room,
        limit = 10,
        fromEvent?: string,
        direction: string = EventTimeline.BACKWARDS,
    ): Promise<MatrixEvent[]> {
        const indexManager = this.indexManager;
        if (!indexManager || this.closed || MatrixClientPeg.get() !== this.indexClient)
            throw new Error("Event index unavailable");

        const loadArgs: ILoadArgs = {
            roomId: room.roomId,
            limit: limit,
        };

        if (fromEvent) {
            loadArgs.fromEvent = fromEvent;
            loadArgs.direction = direction;
        }

        let events: IEventAndProfile[];

        // Get our events from the event index.
        try {
            events = await indexManager.loadFileEvents(loadArgs);
        } catch (e) {
            this.logger.debug("Error getting file events", e);
            throw e;
        }

        if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Event index account changed");
        return this.mapFileEvents(room, events);
    }

    /** Query Web attachments inside the index, retaining its opaque cursor and exhaustion flag. */
    public async queryFileEvents(
        room: Room,
        query: Omit<IFileQuery, "roomId">,
    ): Promise<{ events: MatrixEvent[]; cursor?: string; exhausted: boolean }> {
        const manager = this.indexManager;
        if (!manager?.supportsFilteredFileQuery() || this.closed || MatrixClientPeg.get() !== this.indexClient) {
            throw new Error("Filtered file query unavailable");
        }
        const page = await manager.queryFileEvents({ ...query, roomId: room.roomId });
        if (this.closed || MatrixClientPeg.get() !== this.indexClient) throw new Error("Event index account changed");
        return { ...page, events: this.mapFileEvents(room, page.events) };
    }

    private mapFileEvents(room: Room, events: IEventAndProfile[]): MatrixEvent[] {
        const eventMapper = MatrixClientPeg.safeGet().getEventMapper();

        // Turn the events into MatrixEvent objects.
        const matrixEvents = events.map((e) => {
            const matrixEvent = eventMapper(e.event);
            if (e.original_event) {
                // The indexed projection may be decrypted while original_event keeps the wire type. Its content
                // must already be the clear, unedited attachment content; never use the current projection as base.
                const original = new MatrixEvent({ ...e.original_event, type: matrixEvent.getType() });
                rememberOriginalFileEvent(matrixEvent, original, e.file_edits);
            }

            const member = new RoomMember(room.roomId, matrixEvent.getSender()!);

            // We can't really reconstruct the whole room state from our
            // EventIndex to calculate the correct display name. Use the
            // disambiguated form always instead.
            member.name = e.profile.displayname + " (" + matrixEvent.getSender() + ")";

            // This is sets the avatar URL.
            const memberEvent = eventMapper({
                content: {
                    membership: KnownMembership.Join,
                    avatar_url: e.profile.avatar_url,
                    displayname: e.profile.displayname,
                },
                type: EventType.RoomMember,
                event_id: matrixEvent.getId() + ":eventIndex",
                room_id: matrixEvent.getRoomId(),
                sender: matrixEvent.getSender(),
                origin_server_ts: matrixEvent.getTs(),
                state_key: matrixEvent.getSender(),
            });

            // We set this manually to avoid emitting RoomMember.membership and
            // RoomMember.name events.
            member.events.member = memberEvent;
            matrixEvent.sender = member;

            return matrixEvent;
        });

        return matrixEvents;
    }

    /**
     * Fill a timeline with events that contain URLs.
     *
     * @param {TimelineSet} timelineSet The TimelineSet the Timeline belongs to,
     * used to check if we're adding duplicate events.
     *
     * @param {Timeline} timeline The Timeline which should be filed with
     * events.
     *
     * @param {Room} room The room for which we should fetch events containing
     * URLs
     *
     * @param {number} limit The maximum number of events to fetch.
     *
     * @param {string} fromEvent From which event should we continue fetching
     * events from the index. This is only needed if we're continuing to fill
     * the timeline, e.g. if we're paginating. This needs to be set to a event
     * id of an event that was previously fetched with this function.
     *
     * @param {string} direction The direction in which we will continue
     * fetching events. EventTimeline.BACKWARDS to continue fetching events that
     * are older than the event given in fromEvent, EventTimeline.FORWARDS to
     * fetch newer events.
     *
     * @returns {Promise<boolean>} Resolves to true if events were added to the
     * timeline, false otherwise.
     */
    public async populateFileTimeline(
        timelineSet: EventTimelineSet,
        timeline: EventTimeline,
        room: Room,
        limit = 10,
        fromEvent?: string,
        direction: string = EventTimeline.BACKWARDS,
    ): Promise<boolean> {
        const matrixEvents = await this.loadFileEvents(room, limit, fromEvent, direction);

        // If this is a normal fill request, not a pagination request, we need
        // to get our events in the BACKWARDS direction but populate them in the
        // forwards direction.
        // This needs to happen because a fill request might come with an
        // existing timeline e.g. if you close and re-open the FilePanel.
        if (fromEvent === null) {
            matrixEvents.reverse();
            direction = direction == EventTimeline.BACKWARDS ? EventTimeline.FORWARDS : EventTimeline.BACKWARDS;
        }

        // Add the events to the timeline of the file panel.
        matrixEvents.forEach((e) => {
            if (!timelineSet.eventIdToTimeline(e.getId()!)) {
                timelineSet.addEventToTimeline(e, timeline, {
                    toStartOfTimeline: direction == EventTimeline.BACKWARDS,
                    fromCache: false,
                    addToState: false,
                });
            }
        });

        let ret = false;
        let paginationToken = "";

        // Set the pagination token to the oldest event that we retrieved.
        if (matrixEvents.length > 0) {
            paginationToken = matrixEvents[matrixEvents.length - 1].getId()!;
            ret = true;
        }

        this.logger.debug(
            `Populating file panel with ${matrixEvents.length} events and setting the pagination token to ${paginationToken}`,
        );

        timeline.setPaginationToken(paginationToken, EventTimeline.BACKWARDS);
        return ret;
    }

    /**
     * Emulate a TimelineWindow pagination() request with the event index as the event source
     *
     * Might not fetch events from the index if the timeline already contains
     * events that the window isn't showing.
     *
     * @param {Room} room The room for which we should fetch events containing
     * URLs
     *
     * @param {TimelineWindow} timelineWindow The timeline window that should be
     * populated with new events.
     *
     * @param {string} direction The direction in which we should paginate.
     * EventTimeline.BACKWARDS to paginate back, EventTimeline.FORWARDS to
     * paginate forwards.
     *
     * @param {number} limit The maximum number of events to fetch while
     * paginating.
     *
     * @returns {Promise<boolean>} Resolves to a boolean which is true if more
     * events were successfully retrieved.
     */
    public paginateTimelineWindow(
        room: Room,
        timelineWindow: TimelineWindow,
        direction: Direction,
        limit: number,
    ): Promise<boolean> {
        const tl = timelineWindow.getTimelineIndex(direction);

        if (!tl) return Promise.resolve(false);
        if (tl.pendingPaginate) return tl.pendingPaginate;

        if (timelineWindow.extend(direction, limit)) {
            return Promise.resolve(true);
        }

        const paginationMethod = async (
            timelineWindow: TimelineWindow,
            timelineIndex: TimelineIndex,
            room: Room,
            direction: Direction,
            limit: number,
        ): Promise<boolean> => {
            const timeline = timelineIndex.timeline;
            const timelineSet = timeline.getTimelineSet();
            const token = timeline.getPaginationToken(direction) ?? undefined;

            const ret = await this.populateFileTimeline(timelineSet, timeline, room, limit, token, direction);

            timelineIndex.pendingPaginate = undefined;
            timelineWindow.extend(direction, limit);

            return ret;
        };

        const paginationPromise = paginationMethod(timelineWindow, tl, room, direction, limit);
        tl.pendingPaginate = paginationPromise;

        return paginationPromise;
    }

    /**
     * Get statistical information of the index.
     *
     * @returns {Promise<IIndexStats>} A promise that will resolve to the index
     * statistics.
     */
    public async getStats(): Promise<IIndexStats | undefined> {
        const indexManager = this.activeManager();
        return indexManager?.getStats();
    }

    /**
     * Check if the room with the given id is already indexed.
     *
     * @param {string} roomId The ID of the room which we want to check if it
     * has been already indexed.
     *
     * @returns {Promise<boolean>} Returns true if the index contains events for
     * the given room, false otherwise.
     */
    public async isRoomIndexed(roomId: string): Promise<boolean | undefined> {
        const indexManager = this.activeManager();
        return indexManager?.isRoomIndexed(roomId);
    }

    /**
     * Get the room that we are currently crawling.
     *
     * @returns {Room} A MatrixRoom that is being currently crawled, null
     * if no room is currently being crawled.
     */
    public currentRoom(): Room | null {
        if (this.currentCheckpoint === null && this.crawlerCheckpoints.length === 0) {
            return null;
        }

        const client = MatrixClientPeg.safeGet();

        if (this.currentCheckpoint !== null) {
            return client.getRoom(this.currentCheckpoint.roomId);
        } else {
            return client.getRoom(this.crawlerCheckpoints[0].roomId);
        }
    }

    public crawlingRooms(): {
        /**
         * The rooms with an outstanding crawler checkpoint: the one being crawled right now, and
         * those still queued behind it.
         */
        crawlingRooms: Set<string>;

        /** All the encrypted rooms known by the MatrixClient. */
        totalRooms: Set<string>;
    } {
        const totalRooms = new Set<string>();
        const crawlingRooms = new Set<string>();

        this.crawlerCheckpoints.forEach((checkpoint, index) => {
            crawlingRooms.add(checkpoint.roomId);
        });

        if (this.currentCheckpoint !== null) {
            crawlingRooms.add(this.currentCheckpoint.roomId);
        }

        const client = MatrixClientPeg.safeGet();
        const rooms = client.getRooms();

        const isRoomEncrypted = (room: Room): boolean => {
            return client.isRoomEncrypted(room.roomId);
        };

        const encryptedRooms = rooms.filter(isRoomEncrypted);
        encryptedRooms.forEach((room) => {
            totalRooms.add(room.roomId);
        });

        return { crawlingRooms, totalRooms };
    }
}
