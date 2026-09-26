/*
Copyright 2025 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, type Mocked } from "vitest";
import {
    Direction,
    type MatrixClient,
    type IEvent,
    MatrixEvent,
    type Room,
    ClientEvent,
    SyncState,
    EventType,
    RoomEvent,
    HTTPError,
    type EventTimeline,
} from "matrix-js-sdk/src/matrix";
import { emitPromise, getMockClientWithEventEmitter, mockClientMethodsRooms, mockPlatformPeg } from "test-utils";

import EventIndex from "./EventIndex.ts";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import { type ICrawlerCheckpoint } from "./BaseEventIndexManager.ts";
import { getOriginalFileEvent } from "../search/RoomFileSearchOriginals";
import { RoomFileSearchSession } from "../search/RoomFileSearchSession";
import EventIndexPeg from "./EventIndexPeg";
import SettingsStore from "../settings/SettingsStore.ts";
import { MatrixClientPeg } from "../MatrixClientPeg.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndex", () => {
    it("crawls through the loaded checkpoints", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            supportsLocalUnencryptedRoomSearch: () => true,
            removeCrawlerCheckpoint: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({
            getHumanReadableName: () => "Web Platform",
            getEventIndexingManager: () => mockIndexingManager,
        });

        const room1 = {
            roomId: "!room1:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "token1", getEvents: () => [] }),
        } as unknown as Room;
        const room2 = {
            roomId: "!room2:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "token2", getEvents: () => [] }),
        } as unknown as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        let changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;

        indexer.startCrawler();

        // Mock out the /messags request, and wait for the crawler to hit the first room
        const mock1 = mockCreateMessagesRequest(mockClient);
        let changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room1:id");

        await mock1.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room1:id", "token1", 100, "b");

        // Continue, and wait for the crawler to hit the second room
        changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;
        mock1.resolve({ chunk: [] });
        changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room2:id");

        // Mock out the /messages request again, and wait for it to be called
        const mock2 = mockCreateMessagesRequest(mockClient);
        await mock2.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room2:id", "token2", 100, "f");
    });

    it("should share the background crawler step with foreground backfill without dropping its checkpoint", async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>>();
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([{ roomId: "!room:id", token: "old", direction: Direction.Backward }]),
            removeCrawlerCheckpoint: vi.fn(),
            closeEventIndex: vi.fn(),
            supportsLocalUnencryptedRoomSearch: () => false,
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "old", getEvents: () => [] }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            isRoomEncrypted: () => true,
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockReturnValue(pending.promise),
        });
        vi.spyOn(SettingsStore, "getValueAt").mockReturnValue(0);
        const indexer = new EventIndex();
        await indexer.init();
        const started = emitPromise(indexer, "changedCheckpoint");
        indexer.startCrawler();
        await started;
        const foreground = indexer.backfillRoom(room.roomId);
        pending.resolve({ chunk: [] } as Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>);
        expect((await foreground).reason).toBe("end");
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(1);
        await indexer.close();
    });

    it("should wake an idle crawler on close without starting another request", async () => {
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            closeEventIndex: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            supportsLocalUnencryptedRoomSearch: () => false,
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const client = getMockClientWithEventEmitter({ createMessagesRequest: vi.fn() });
        vi.spyOn(SettingsStore, "getValueAt").mockReturnValue(0);
        const indexer = new EventIndex();
        await indexer.init();
        vi.useFakeTimers();
        try {
            indexer.startCrawler();
            await vi.advanceTimersByTimeAsync(100); // enter the 5s idle wait
            await indexer.close();
            expect(vi.getTimerCount()).toBe(0);
            expect(client.createMessagesRequest).not.toHaveBeenCalled();
            expect(manager.closeEventIndex).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should import the loaded timeline before a backward checkpoint", async () => {
        const event = new MatrixEvent({
            event_id: "$recent",
            room_id: "!room:id",
            type: EventType.RoomMessage,
            sender: "@a:id",
            origin_server_ts: 1,
            content: { msgtype: "m.text", body: "recent" },
        });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "older", getEvents: () => [event] }),
        } as unknown as Room;
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            addCrawlerCheckpoint: vi.fn(),
            addEventToIndex: vi.fn(),
            supportsLocalUnencryptedRoomSearch: () => true,
            removeCrawlerCheckpoint: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getHumanReadableName: () => "Web Platform", getEventIndexingManager: () => manager });
        getMockClientWithEventEmitter({
            getRoom: () => room,
            isRoomEncrypted: () => false,
            decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockResolvedValue({ chunk: [] }),
        });
        const indexer = new EventIndex();
        await indexer.init();
        expect((await indexer.backfillRoom(room.roomId)).reason).toBe("end");
        expect(manager.addEventToIndex).toHaveBeenCalledWith(
            expect.objectContaining({ event_id: "$recent" }),
            expect.anything(),
        );
    });

    it("preserves the clear event type when mapping an encrypted indexed original", async () => {
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => null, getEvents: () => [] }),
        } as unknown as Room;
        const encryptedFile = {
            url: "mxc://example.org/report",
            key: {
                kty: "oct",
                key_ops: ["encrypt", "decrypt"],
                alg: "A256CTR",
                k: "fixture-key",
                ext: true,
            },
            iv: "fixture-iv",
            hashes: { sha256: "fixture-hash" },
        };
        const original: Partial<IEvent> = {
            event_id: "$encrypted",
            room_id: room.roomId,
            type: "m.room.encrypted",
            sender: "@a:id",
            origin_server_ts: 10,
            // The stored original keeps the clear attachment content even though its raw type is encrypted.
            content: { msgtype: "m.file", body: "report.pdf", filename: "report.pdf", file: encryptedFile },
        };
        const display: Partial<IEvent> = {
            ...original,
            type: EventType.RoomMessage,
            content: { msgtype: "m.file", body: "report-v2.pdf", filename: "report-v2.pdf", file: encryptedFile },
        };
        const manager = {
            supportsLocalUnencryptedRoomSearch: () => true,
            supportsFilteredFileQuery: () => true,
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            queryFileEvents: vi.fn().mockResolvedValue({
                events: [
                    {
                        event: display,
                        original_event: original,
                        file_edits: [
                            {
                                event_id: "$edit",
                                room_id: room.roomId,
                                sender: "@a:id",
                                timestamp: 20,
                                content: {
                                    msgtype: "m.file",
                                    body: "report-v2.pdf",
                                    filename: "report-v2.pdf",
                                    file: encryptedFile,
                                },
                            },
                        ],
                        profile: { displayname: "Alice", avatar_url: undefined },
                    },
                ],
                exhausted: true,
            }),
            closeEventIndex: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getHumanReadableName: () => "Web Platform", getEventIndexingManager: () => manager });
        getMockClientWithEventEmitter({
            getRoom: () => room,
            getEventMapper: () => (event: Partial<IEvent>) => new MatrixEvent(event),
        });

        const indexer = new EventIndex();
        await indexer.init();
        const page = await indexer.queryFileEvents(room, { category: "files", term: "report", limit: 10 });
        const mapped = page.events[0];
        const retained = getOriginalFileEvent(mapped);
        expect(mapped.getType()).toBe(EventType.RoomMessage);
        expect(retained?.original.getType()).toBe(EventType.RoomMessage);
        expect(retained?.original.getContent()).toMatchObject({ filename: "report.pdf", file: encryptedFile });

        // Run the mapped event through the real Session owner to cover edit withdrawal and a refresh.
        vi.spyOn(EventIndexPeg, "get").mockReturnValue(indexer);
        const session = new RoomFileSearchSession(MatrixClientPeg.safeGet(), room, indexer, "files", "report", true);
        session.add(mapped);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report-v2.pdf"]);
        expect(session.current[0].getType()).toBe(EventType.RoomMessage);
        expect(session.current[0].getContent()).toMatchObject({ file: encryptedFile });
        session.redact("$edit");
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report.pdf"]);
        expect(session.current[0].getType()).toBe(EventType.RoomMessage);
        session.refreshIndexedResults();
        expect(session.resume()).toBe(true);
        await session.loadMore(false);
        expect(session.current.map((event) => event.getContent().filename)).toEqual(["report.pdf"]);
        expect(session.current[0].getType()).toBe(EventType.RoomMessage);
        expect(session.current[0].getContent()).toMatchObject({ file: encryptedFile });
        await indexer.close();
    });

    it("should share an in-flight backfill between callers", async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>>();
        const manager = {
            supportsLocalUnencryptedRoomSearch: () => true,
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([{ roomId: "!room:id", token: "older", direction: Direction.Backward }]),
            removeCrawlerCheckpoint: vi.fn(),
            addHistoricEvents: vi.fn().mockResolvedValue(false),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getHumanReadableName: () => "Web Platform", getEventIndexingManager: () => manager });
        const client = getMockClientWithEventEmitter({
            isRoomEncrypted: () => false,
            createMessagesRequest: vi.fn().mockReturnValue(pending.promise),
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            getRoom: () =>
                ({
                    roomId: "!room:id",
                    getLiveTimeline: () => ({ getPaginationToken: () => "older", getEvents: () => [] }),
                }) as unknown as Room,
        });
        const indexer = new EventIndex();
        await indexer.init();
        const first = indexer.backfillRoom("!room:id");
        const second = indexer.backfillRoom("!room:id");
        pending.resolve({
            chunk: [
                {
                    event_id: "$old",
                    room_id: "!room:id",
                    type: EventType.RoomMessage,
                    sender: "@a:id",
                    origin_server_ts: 1,
                    content: { msgtype: "m.text", body: "old" },
                },
            ],
            end: "next",
        } as Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>);
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toEqual(secondResult);
        expect(firstResult.canContinue).toBe(true);
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(1);
    });

    it("should stop when the server returns a non-advancing room-history cursor", async () => {
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            addCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
            addHistoricEvents: vi.fn().mockResolvedValue(false),
            removeCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
            supportsLocalUnencryptedRoomSearch: () => true,
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "same", getEvents: () => [] }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            isRoomEncrypted: () => false,
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockResolvedValue({
                chunk: [
                    {
                        event_id: "$same-cursor",
                        room_id: room.roomId,
                        sender: "@a:id",
                        origin_server_ts: 1,
                        type: EventType.RoomMessage,
                        content: { msgtype: "m.text", body: "event" },
                    },
                ],
                end: "same",
            }),
        });
        const indexer = new EventIndex();
        await indexer.init();

        const first = await indexer.backfillRoom(room.roomId);
        expect(first).toMatchObject({ canContinue: false, reason: "stalled" });
        expect(client.createMessagesRequest).toHaveBeenCalledOnce();
        indexer.removeListeners();
    });

    it("should delete an indexed event when a redaction arrives in another room", async () => {
        const manager = {
            deleteEvent: vi.fn(),
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => true,
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getHumanReadableName: () => "Web Platform", getEventIndexingManager: () => manager });
        const client = getMockClientWithEventEmitter({ isRoomEncrypted: () => false });
        const indexer = new EventIndex();
        await indexer.init();
        const redaction = new MatrixEvent({
            event_id: "$redaction",
            room_id: "!other:id",
            type: EventType.RoomRedaction,
            sender: "@a:id",
            origin_server_ts: 2,
            redacts: "$original",
            content: {},
        });
        client.emit(RoomEvent.Timeline, redaction, { roomId: "!other:id" } as Room, false, false, {
            liveEvent: true,
            timeline: {} as EventTimeline,
        });
        await vi.waitFor(() => expect(manager.deleteEvent).toHaveBeenCalledWith("$original"));
        indexer.removeListeners();
    });

    it("should queue a new limited-timeline gap after an in-flight room step without losing either token", async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>>();
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([{ roomId: "!room:id", token: "old", direction: Direction.Backward }]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            addHistoricEvents: vi.fn().mockResolvedValue(false),
            closeEventIndex: vi.fn(),
            supportsLocalUnencryptedRoomSearch: () => false,
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        let token = "gap-one";
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => token,
                getEvents: () => [],
            }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            isRoomEncrypted: () => true,
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ chunk: [] }),
        });
        const indexer = new EventIndex();
        await indexer.init();
        const first = indexer.backfillRoom(room.roomId);
        client.emit(RoomEvent.TimelineReset, room);
        token = "gap-two";
        client.emit(RoomEvent.TimelineReset, room);
        const response = {
            chunk: [
                {
                    event_id: "$old",
                    room_id: room.roomId,
                    type: EventType.RoomMessage,
                    sender: "@a:id",
                    origin_server_ts: 1,
                    content: { msgtype: "m.text", body: "old" },
                },
            ],
            end: "next",
        };
        pending.resolve(response as Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>);
        expect((await first).exhausted).toBe(false);
        await vi.waitFor(() =>
            expect(manager.addCrawlerCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ token: "gap-two" })),
        );
        await indexer.backfillRoom(room.roomId);
        await indexer.backfillRoom(room.roomId);
        await indexer.backfillRoom(room.roomId);
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(4);
        expect(client.createMessagesRequest).toHaveBeenNthCalledWith(2, room.roomId, "next", 100, Direction.Backward);
        expect(client.createMessagesRequest).toHaveBeenNthCalledWith(
            3,
            room.roomId,
            "gap-one",
            100,
            Direction.Backward,
        );
        expect(client.createMessagesRequest).toHaveBeenNthCalledWith(
            4,
            room.roomId,
            "gap-two",
            100,
            Direction.Backward,
        );
        await indexer.close();
    });

    it("should retain a same-token initial gap when another reset is already pending", async () => {
        let token = "old";
        const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>>();
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([
                    { roomId: "!room:id", token: "old", rootToken: "old", direction: Direction.Backward },
                ]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            supportsLocalUnencryptedRoomSearch: () => false,
            removeCrawlerCheckpoint: vi.fn(),
            addCrawlerCheckpoint: vi.fn(),
            closeEventIndex: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => token, getEvents: () => [] }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            getRoom: () => room,
            getRooms: () => [room],
            isRoomEncrypted: () => true,
            getCrypto: () => ({ isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) }) as never,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ chunk: [] }),
        });
        const indexer = new EventIndex();
        await indexer.init();
        const first = indexer.backfillRoom(room.roomId);
        token = "other-gap";
        client.emit(RoomEvent.TimelineReset, room);
        token = "old";
        const initial = indexer.addInitialCheckpoints();
        pending.resolve({ chunk: [] } as Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>);
        await first;
        await initial;
        expect(manager.addCrawlerCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({
                token: "old",
                direction: Direction.Backward,
            }),
        );
        await indexer.backfillRoom(room.roomId);
        await indexer.backfillRoom(room.roomId);
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(3);
        await indexer.close();
    });

    it("should not complete a newly changed live token when an older gap ends", async () => {
        let token = "old";
        const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>>();
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([
                    { roomId: "!room:id", token: "old", rootToken: "old", direction: Direction.Backward },
                ]),
            supportsLocalUnencryptedRoomSearch: () => true,
            removeCrawlerCheckpoint: vi.fn(),
            markRoomHistoryComplete: vi.fn(),
            addCrawlerCheckpoint: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => token, getEvents: () => [] }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ chunk: [] }),
        });
        const indexer = new EventIndex();
        await indexer.init();
        const old = indexer.backfillRoom(room.roomId);
        token = "new-gap";
        pending.resolve({ chunk: [] } as Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>);
        expect((await old).exhausted).toBe(false);
        expect(manager.markRoomHistoryComplete).not.toHaveBeenCalled();
        expect((await indexer.backfillRoom(room.roomId)).exhausted).toBe(true);
        expect(client.createMessagesRequest).toHaveBeenNthCalledWith(
            2,
            room.roomId,
            "new-gap",
            100,
            Direction.Backward,
        );
    });

    it("should report 403 as inaccessible history without persisting a completed boundary", async () => {
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([
                    { roomId: "!room:id", token: "old", rootToken: "old", direction: Direction.Backward },
                ]),
            supportsLocalUnencryptedRoomSearch: () => true,
            removeCrawlerCheckpoint: vi.fn(),
            markRoomHistoryComplete: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "old", getEvents: () => [] }),
        } as unknown as Room;
        getMockClientWithEventEmitter({
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockRejectedValue(new HTTPError("Forbidden", 403)),
        });
        const indexer = new EventIndex();
        await indexer.init();
        expect(await indexer.backfillRoom(room.roomId)).toEqual(
            expect.objectContaining({
                exhausted: false,
                reason: "forbidden",
            }),
        );
        expect(manager.markRoomHistoryComplete).not.toHaveBeenCalled();
    });

    it("should not restart from the live token after more than 32 pages or after reopening", async () => {
        let savedToken: string | null = null;
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValueOnce([{ roomId: "!room:id", token: "initial", direction: Direction.Backward }])
                .mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => true,
            addHistoricEvents: vi.fn().mockResolvedValue(false),
            removeCrawlerCheckpoint: vi.fn(),
            getCompletedRoomToken: vi.fn().mockImplementation(async () => savedToken),
            markRoomHistoryComplete: vi.fn().mockImplementation(async (_roomId: string, token: string) => {
                savedToken = token;
            }),
            closeEventIndex: vi.fn(),
            addCrawlerCheckpoint: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "initial", getEvents: () => [] }),
        } as unknown as Room;
        let page = 0;
        const client = getMockClientWithEventEmitter({
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockImplementation(async () => {
                page++;
                return page <= 40
                    ? {
                          chunk: [
                              {
                                  event_id: `$${page}`,
                                  room_id: room.roomId,
                                  sender: "@a:id",
                                  type: EventType.RoomMessage,
                                  origin_server_ts: page,
                                  content: { msgtype: "m.text", body: "old" },
                              },
                          ],
                          end: `next-${page}`,
                      }
                    : { chunk: [] };
            }),
        });
        const indexer = new EventIndex();
        await indexer.init();
        for (let i = 0; i < 41; i++) await indexer.backfillRoom(room.roomId);
        expect(savedToken).toBe("initial");
        expect((await indexer.backfillRoom(room.roomId)).exhausted).toBe(true);
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(41);
        await indexer.close();
        const reopened = new EventIndex();
        await reopened.init();
        expect((await reopened.backfillRoom(room.roomId)).exhausted).toBe(true);
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(41);
        await reopened.close();
    });

    it("should allow a limited reset with the same token after a missing server cursor", async () => {
        const manager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([{ roomId: "!room:id", token: "same", direction: Direction.Backward }]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            supportsLocalUnencryptedRoomSearch: () => false,
            addHistoricEvents: vi.fn().mockResolvedValue(false),
            addCrawlerCheckpoint: vi.fn(),
            markRoomHistoryComplete: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "same", getEvents: () => [] }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            isRoomEncrypted: () => true,
            getRoom: () => room,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockResolvedValue({
                chunk: [
                    {
                        event_id: "$one",
                        room_id: room.roomId,
                        sender: "@a:id",
                        type: EventType.RoomMessage,
                        origin_server_ts: 1,
                        content: { msgtype: "m.text", body: "old" },
                    },
                ],
            }),
        });
        const indexer = new EventIndex();
        await indexer.init();
        expect((await indexer.backfillRoom(room.roomId)).reason).toBe("missing_token");
        client.emit(RoomEvent.TimelineReset, room);
        await vi.waitFor(() =>
            expect(manager.addCrawlerCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ token: "same" })),
        );
        await indexer.backfillRoom(room.roomId);
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(2);
        expect(manager.markRoomHistoryComplete).not.toHaveBeenCalled();
    });

    it("should not enqueue a checkpoint if its persistent write fails", async () => {
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => true,
            addCrawlerCheckpoint: vi.fn().mockRejectedValue(new Error("storage failure")),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "older", getEvents: () => [] }),
        } as unknown as Room;
        getMockClientWithEventEmitter({ getRoom: () => room });
        const indexer = new EventIndex();
        await indexer.init();
        const result = await indexer.backfillRoom(room.roomId);
        expect(result.error).toBeInstanceOf(Error);
        expect(indexer.hasBackfillForRoom(room.roomId)).toBe(false);
    });

    it("should discard first-sync rooms if the account changes during encryption filtering", async () => {
        const encryptionCheck = Promise.withResolvers<boolean>();
        const oldManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => true,
            addCrawlerCheckpoint: vi.fn(),
            closeEventIndex: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        const newManager = { addCrawlerCheckpoint: vi.fn() } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => oldManager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "first", getEvents: () => [] }),
        } as unknown as Room;
        getMockClientWithEventEmitter({
            getRooms: () => [room],
            getRoom: () => room,
            getCrypto: () => ({ isEncryptionEnabledInRoom: () => encryptionCheck.promise }) as never,
        });
        const indexer = new EventIndex();
        await indexer.init();
        const adding = indexer.addInitialCheckpoints();
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue({ getRoom: () => room } as unknown as MatrixClient);
        mockPlatformPeg({ getEventIndexingManager: () => newManager });
        encryptionCheck.resolve(true);
        await adding;
        expect(oldManager.addCrawlerCheckpoint).not.toHaveBeenCalled();
        expect(newManager.addCrawlerCheckpoint).not.toHaveBeenCalled();
        await indexer.close();
    });

    it("should report a queued initial-sync backward checkpoint as continuable", async () => {
        const checkpointWrite = Promise.withResolvers<void>();
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            supportsLocalUnencryptedRoomSearch: () => false,
            addCrawlerCheckpoint: vi.fn().mockReturnValue(checkpointWrite.promise),
            closeEventIndex: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "first", getEvents: () => [] }),
        } as unknown as Room;
        getMockClientWithEventEmitter({
            getRoom: () => room,
            getRooms: () => [room],
            getCrypto: () => ({ isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) }) as never,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
        });
        vi.spyOn(SettingsStore, "getValueAt").mockReturnValue(0);
        const indexer = new EventIndex();
        await indexer.init();
        const initial = indexer.addInitialCheckpoints();
        await vi.waitFor(() => expect(manager.addCrawlerCheckpoint).toHaveBeenCalledOnce());

        const waitingBackfill = indexer.backfillRoom(room.roomId);
        checkpointWrite.resolve();
        await expect(waitingBackfill).resolves.toMatchObject({ canContinue: true, exhausted: false });
        await initial;
        await indexer.close();
    });

    it("should serialize first-sync checkpoints with foreground backfill", async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>>();
        const committed = Promise.withResolvers<void>();
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            supportsLocalUnencryptedRoomSearch: () => false,
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            closeEventIndex: vi.fn(),
            commitLiveEvents: vi.fn().mockImplementation(async () => committed.resolve()),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "first", getEvents: () => [] }),
        } as unknown as Room;
        const client = getMockClientWithEventEmitter({
            getRoom: () => room,
            getRooms: () => [room],
            isRoomEncrypted: () => true,
            getCrypto: () => ({ isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) }) as never,
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockReturnValue(pending.promise),
        });
        vi.spyOn(SettingsStore, "getValueAt").mockReturnValue(0);
        const indexer = new EventIndex();
        await indexer.init();
        const foreground = indexer.backfillRoom(room.roomId);
        client.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
        pending.resolve({ chunk: [] } as Awaited<ReturnType<MatrixClient["createMessagesRequest"]>>);
        await foreground;
        await committed.promise;
        expect(manager.addCrawlerCheckpoint).toHaveBeenCalledTimes(2);
        expect(manager.addCrawlerCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ token: "first", direction: Direction.Forward }),
        );
        expect(client.createMessagesRequest).toHaveBeenCalledTimes(1);
        await indexer.close();
    });

    it("should pass the complete decrypted edit event to the manager and ignore decryption failures", async () => {
        const manager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => true,
            applyEventEdit: vi.fn().mockResolvedValue(undefined),
            closeEventIndex: vi.fn().mockResolvedValue(undefined),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => manager });
        getMockClientWithEventEmitter({});
        const indexer = new EventIndex();
        await indexer.init();
        const edit = new MatrixEvent({
            event_id: "$edit",
            room_id: "!room:id",
            sender: "@a:id",
            origin_server_ts: 20,
            type: EventType.RoomMessage,
            content: {
                "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
                "m.new_content": { msgtype: "m.text", body: "edited" },
            },
        });
        const applyEdit = (indexer as unknown as { applyEditIfNeeded: (event: MatrixEvent) => Promise<boolean> })
            .applyEditIfNeeded;
        expect(await applyEdit.call(indexer, edit)).toBe(true);
        expect(manager.applyEventEdit).toHaveBeenCalledWith(
            expect.objectContaining({
                event_id: "$edit",
                room_id: "!room:id",
                sender: "@a:id",
                origin_server_ts: 20,
                content: edit.getContent(),
            }),
        );

        const failedEdit = new MatrixEvent({
            ...edit.event,
            event_id: "$failed-edit",
        });
        vi.spyOn(failedEdit, "isDecryptionFailure").mockReturnValue(true);
        expect(await applyEdit.call(indexer, failedEdit)).toBe(false);
        expect(manager.applyEventEdit).toHaveBeenCalledOnce();
        await indexer.close();
    });

    it("should ignore old client writes after switching accounts, including delayed decryption", async () => {
        const decrypt = Promise.withResolvers<void>();
        const oldManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => true,
            addEventToIndex: vi.fn(),
            deleteEvent: vi.fn(),
            applyEventEdit: vi.fn(),
            addCrawlerCheckpoint: vi.fn(),
            closeEventIndex: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        const newManager = {
            addEventToIndex: vi.fn(),
            deleteEvent: vi.fn(),
            applyEventEdit: vi.fn(),
            addCrawlerCheckpoint: vi.fn(),
        } as unknown as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => oldManager });
        const event = new MatrixEvent({
            event_id: "$plain",
            room_id: "!room:id",
            type: EventType.RoomMessage,
            sender: "@a:id",
            origin_server_ts: 1,
            content: { msgtype: "m.text", body: "old account" },
        });
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => ({ getPaginationToken: () => "old", getEvents: () => [event] }),
        } as unknown as Room;
        const oldClient = getMockClientWithEventEmitter({
            getRoom: () => room,
            decryptEventIfNeeded: vi.fn().mockReturnValue(decrypt.promise),
        });
        const indexer = new EventIndex();
        await indexer.init();
        const loading = indexer.ensureRoomTimelineIndexed(room.roomId);
        const newClient = { getRoom: () => room } as unknown as MatrixClient;
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(newClient);
        mockPlatformPeg({ getEventIndexingManager: () => newManager });
        decrypt.resolve();
        await expect(loading).rejects.toThrow("account changed");
        const redaction = new MatrixEvent({
            event_id: "$redaction",
            room_id: room.roomId,
            type: EventType.RoomRedaction,
            redacts: "$plain",
            content: {},
        });
        oldClient.emit(RoomEvent.Timeline, redaction, room, false, false, {
            liveEvent: true,
            timeline: {} as EventTimeline,
        });
        oldClient.emit(RoomEvent.TimelineReset, room);
        await Promise.resolve();
        expect(newManager.deleteEvent).not.toHaveBeenCalled();
        expect(newManager.addEventToIndex).not.toHaveBeenCalled();
        expect(newManager.addCrawlerCheckpoint).not.toHaveBeenCalled();
        expect(oldManager.addEventToIndex).not.toHaveBeenCalled();
        await indexer.close();
    });

    it("adds checkpoints for the encrypted rooms after the first sync", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            supportsLocalUnencryptedRoomSearch: () => false,
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            commitLiveEvents: vi.fn(),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({
            getHumanReadableName: () => "Electron",
            getEventIndexingManager: () => mockIndexingManager,
        });

        const room1 = {
            roomId: "!room1:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => "token1",
                getEvents: () => [],
            }),
        } as any as Room;
        const room2 = {
            roomId: "!room2:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => "token2",
                getEvents: () => [],
            }),
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room1, room2]),
        });

        const commitLiveEventsCalled = Promise.withResolvers<void>();
        mockIndexingManager.commitLiveEvents.mockImplementation(async () => {
            commitLiveEventsCalled.resolve();
        });

        const indexer = new EventIndex();
        await indexer.init();

        // During the first sync, some events are added to the index, meaning that `isEventIndexEmpty` will now be false.
        mockIndexingManager.isEventIndexEmpty.mockResolvedValue(false);

        // The first sync completes:
        mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});

        // Wait for `commitLiveEvents` to be called, by which time the checkpoints should have been added.
        await commitLiveEventsCalled.promise;
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledTimes(4);
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Forward,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Forward,
        });
    });
});

/**
 * Mock out the `createMessagesRequest` method on the client, with an implementation that will block until a resolver is called.
 *
 * @returns An object with the following properties:
 *  * `called`: A promise that resolves when `createMessagesRequest` is called.
 *  * `resolve`: A function that can be called to allow `createMessagesRequest` to complete.
 */
function mockCreateMessagesRequest(mockClient: Mocked<MatrixClient>): {
    called: Promise<void>;
    resolve: (result: any) => void;
} {
    const messagesCalledPromise = Promise.withResolvers<void>();
    const messagesResultPromise = Promise.withResolvers();
    mockClient.createMessagesRequest.mockImplementationOnce(() => {
        messagesCalledPromise.resolve();
        return messagesResultPromise.promise as any;
    });
    return {
        called: messagesCalledPromise.promise,
        resolve: messagesResultPromise.resolve,
    };
}
