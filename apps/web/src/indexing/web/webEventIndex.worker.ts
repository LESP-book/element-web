/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type {
    ICrawlerCheckpoint,
    IEventAndProfile,
    IIndexStats,
    IFileQuery,
    IFileQueryPage,
    ILoadArgs,
    ISearchArgs,
} from "../BaseEventIndexManager";
import type { IEventWithRoomId, IMatrixProfile, IResultRoomEvents, ISearchResult } from "matrix-js-sdk/src/matrix";
import { WebEventIndexDatabase } from "./WebEventIndexDatabase";
import {
    applyEventEditToIndex,
    deleteEventFromIndex,
    makeEventRecord,
    projectLatestEdit,
    type EventRecord,
} from "./webEventEditStore";
import { addRecord, requestToPromise, transactionDone } from "./webEventIndexIdb";
import { WebEventIndexError, type WebEventIndexWorkerOperation } from "./WebEventIndexError";

interface WorkerRequest {
    id: number;
    name: WebEventIndexWorkerOperation;
    args: any[];
}

const ctx = self as any;

const DEFAULT_MAX_EVENT_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TS = Number.MAX_SAFE_INTEGER;
const MAX_EVENT_ID = "\uffff";
// 单次搜索最多扫描的记录数，避免罕见关键词导致一次性遍历整个 IndexedDB 卡顿。
const MAX_SCAN_RECORDS = 2000;
const TEXT_MESSAGE_TYPES = new Set(["m.text", "m.notice", "m.emote"]);
let maxEventAgeMs = DEFAULT_MAX_EVENT_AGE_DAYS * DAY_MS;
const eventIndexDatabase = new WebEventIndexDatabase();

function ensureDb(): IDBDatabase {
    return eventIndexDatabase.get();
}

function getCutoffTs(): number {
    if (!maxEventAgeMs || maxEventAgeMs <= 0) return 0;
    return Date.now() - maxEventAgeMs;
}

async function setMaxEventAgeDays(days?: number): Promise<void> {
    if (typeof days !== "number" || !Number.isFinite(days)) return;
    if (days <= 0) {
        // 0/负数：不做“按时间淘汰”，允许索引任意历史（对齐 FluffyChat 的“按需拉取/无限回溯”体验）。
        maxEventAgeMs = 0;
        return;
    }
    maxEventAgeMs = Math.max(1, Math.floor(days)) * DAY_MS;
}

function isEventTooOld(ev: IEventWithRoomId, cutoffTs: number): boolean {
    if (!cutoffTs) return false;
    const ts = ev.origin_server_ts;
    if (typeof ts !== "number" || ts <= 0) return false;
    return ts < cutoffTs;
}

async function supportsEventIndexing(): Promise<boolean> {
    return typeof indexedDB !== "undefined";
}

async function initEventIndex(userId: string, deviceId: string): Promise<number> {
    const sourceVersion = await eventIndexDatabase.init(userId, deviceId);
    maxEventAgeMs = DEFAULT_MAX_EVENT_AGE_DAYS * DAY_MS;
    return sourceVersion;
}

async function addEventToIndex(ev: IEventWithRoomId, profile: IMatrixProfile): Promise<void> {
    if (!ev.event_id) return;
    const cutoffTs = getCutoffTs();
    if (isEventTooOld(ev, cutoffTs)) return;

    const tx = ensureDb().transaction(["events", "redacted", "edit_relations"], "readwrite");
    const store = tx.objectStore("events");
    if (!(await requestToPromise(tx.objectStore("redacted").get(ev.event_id)))) {
        const record = await projectLatestEdit(tx, makeEventRecord(ev, profile));
        // Re-decryption of the same event ID replaces its previous encrypted/failed content.
        store.put(record);
    }
    await transactionDone(tx);
}

async function applyEventEdit(edit: IEventWithRoomId): Promise<void> {
    const tx = ensureDb().transaction(["events", "edit_relations", "redacted"], "readwrite");
    await applyEventEditToIndex(tx, edit);
    await transactionDone(tx);
}

async function deleteEvent(eventId: string): Promise<boolean> {
    const tx = ensureDb().transaction(["events", "edit_relations", "redacted"], "readwrite");
    await deleteEventFromIndex(tx, eventId);
    await transactionDone(tx);
    return true;
}

async function isEventIndexEmpty(): Promise<boolean> {
    const database = ensureDb();
    const tx = database.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const count = await requestToPromise(store.count());
    await transactionDone(tx);
    return count === 0;
}

async function isRoomIndexed(roomId: string): Promise<boolean> {
    const database = ensureDb();
    const tx = database.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("room_id");
    const count = await requestToPromise(index.count(IDBKeyRange.only(roomId)));
    await transactionDone(tx);
    return count > 0;
}

async function commitLiveEvents(): Promise<void> {
    return;
}

function parseNextBatch(nextBatch?: string): { key?: IDBValidKey; count?: number; exhausted?: boolean } {
    if (!nextBatch) return {};
    try {
        const parsed = JSON.parse(nextBatch);
        if (parsed && typeof parsed === "object") {
            return {
                key: parsed.key,
                count: parsed.count,
                exhausted: Boolean(parsed.exhausted),
            };
        }
        return { key: parsed as IDBValidKey };
    } catch {
        return {};
    }
}

function buildRoomRange(roomId: string, startKey?: IDBValidKey, direction: "prev" | "next" = "prev"): IDBKeyRange {
    const lower = [roomId, 0, ""] as IDBValidKey;
    const upper = [roomId, MAX_TS, MAX_EVENT_ID] as IDBValidKey;
    if (!startKey) return IDBKeyRange.bound(lower, upper);
    if (direction === "prev") {
        return IDBKeyRange.bound(lower, startKey, false, true);
    }
    return IDBKeyRange.bound(startKey, upper, true, false);
}

async function fetchEvents(
    roomId: string,
    range: IDBKeyRange,
    direction: IDBCursorDirection,
    limit: number,
): Promise<Array<{ event: IEventWithRoomId; profile: IMatrixProfile }>> {
    const database = ensureDb();
    const tx = database.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("room_ts");
    const results: Array<{ event: IEventWithRoomId; profile: IMatrixProfile }> = [];

    await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(range, direction);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || results.length >= limit) {
                resolve();
                return;
            }
            const record = cursor.value as EventRecord;
            const event = JSON.parse(record.event_json) as IEventWithRoomId;
            const profile = record.profile_json ? (JSON.parse(record.profile_json) as IMatrixProfile) : {};
            results.push({ event, profile });
            cursor.continue();
        };
    });

    await transactionDone(tx);
    return results;
}

async function buildContext(
    event: IEventWithRoomId,
    profile: IMatrixProfile,
    beforeLimit: number,
    afterLimit: number,
): Promise<{
    events_before: IEventWithRoomId[];
    events_after: IEventWithRoomId[];
    profile_info: Record<string, IMatrixProfile>;
}> {
    const roomId = event.room_id;
    const ts = event.origin_server_ts ?? 0;
    const eventId = event.event_id;

    const beforeRange = IDBKeyRange.bound([roomId, 0, ""], [roomId, ts, eventId], false, true);
    const afterRange = IDBKeyRange.bound([roomId, ts, eventId], [roomId, MAX_TS, MAX_EVENT_ID], true, false);

    const before = beforeLimit > 0 ? await fetchEvents(roomId, beforeRange, "prev", beforeLimit) : [];
    const after = afterLimit > 0 ? await fetchEvents(roomId, afterRange, "next", afterLimit) : [];

    const profileInfo: Record<string, IMatrixProfile> = {};
    const all = [...before, { event, profile }, ...after];
    for (const item of all) {
        const sender = item.event.sender;
        if (!sender) continue;
        if (Object.keys(item.profile || {}).length > 0) {
            profileInfo[sender] = item.profile;
        }
    }

    return {
        events_before: before.map((item) => item.event),
        events_after: after.map((item) => item.event),
        profile_info: profileInfo,
    };
}

async function scanRoomForMatches(
    roomId: string,
    termLower: string,
    limit: number,
    startKey?: IDBValidKey,
): Promise<{ records: EventRecord[]; nextKey?: IDBValidKey; exhausted: boolean }> {
    const database = ensureDb();
    const tx = database.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("room_ts");
    const range = buildRoomRange(roomId, startKey, "prev");

    const records: EventRecord[] = [];
    let nextKey: IDBValidKey | undefined;
    let lastKey: IDBValidKey | undefined;
    let exhausted = false;
    let scanned = 0;
    let resolved = false;

    await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(range, "prev");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            if (resolved) return;
            const cursor = request.result;
            if (!cursor) {
                exhausted = true;
                if (lastKey) nextKey = lastKey;
                else if (startKey) nextKey = startKey;
                resolved = true;
                resolve();
                return;
            }
            scanned += 1;
            lastKey = cursor.key;
            const record = cursor.value as EventRecord;
            if (record.type !== "m.room.message" || !TEXT_MESSAGE_TYPES.has(record.msgtype ?? "")) {
                if (scanned >= MAX_SCAN_RECORDS) {
                    nextKey = cursor.key;
                    resolved = true;
                    resolve();
                    return;
                }
                cursor.continue();
                return;
            }
            const bodyLower = record.body_lower ?? "";
            if (bodyLower.includes(termLower)) {
                records.push(record);
                if (records.length >= limit) {
                    nextKey = cursor.key;
                    resolved = true;
                    resolve();
                    return;
                }
            }
            if (scanned >= MAX_SCAN_RECORDS) {
                nextKey = cursor.key;
                resolved = true;
                resolve();
                return;
            }
            cursor.continue();
        };
    });

    await transactionDone(tx);
    return { records, nextKey, exhausted };
}

async function searchEventIndex(searchArgs: ISearchArgs): Promise<IResultRoomEvents> {
    const roomId = searchArgs.room_id;
    if (!roomId) {
        return { results: [], highlights: [], count: 0 };
    }

    const term = searchArgs.search_term?.trim() ?? "";
    if (!term) {
        return { results: [], highlights: [], count: 0 };
    }

    const limit = searchArgs.limit ?? 10;
    const beforeLimit = searchArgs.before_limit ?? 1;
    const afterLimit = searchArgs.after_limit ?? 1;
    const { key: startKey, count: baseCount } = parseNextBatch(searchArgs.next_batch);

    const { records, nextKey, exhausted } = await scanRoomForMatches(roomId, term.toLowerCase(), limit, startKey);

    const results: ISearchResult[] = [];
    for (const record of records) {
        const event = JSON.parse(record.event_json) as IEventWithRoomId;
        const profile = record.profile_json ? (JSON.parse(record.profile_json) as IMatrixProfile) : {};
        const context = await buildContext(event, profile, beforeLimit, afterLimit);
        if (event.sender && Object.keys(profile).length > 0) {
            context.profile_info[event.sender] = profile;
        }
        results.push({
            rank: 0,
            result: event,
            context,
        });
    }

    const totalCount = (typeof baseCount === "number" ? baseCount : 0) + results.length;

    return {
        count: totalCount,
        highlights: [term],
        results,
        next_batch: JSON.stringify({ key: nextKey, count: totalCount, exhausted }),
    };
}

async function addHistoricEvents(
    events: IEventAndProfile[],
    checkpoint: ICrawlerCheckpoint | null,
    oldCheckpoint: ICrawlerCheckpoint | null,
): Promise<boolean> {
    const cutoffTs = getCutoffTs();
    const database = ensureDb();
    const tx = database.transaction(["events", "checkpoints", "redacted", "edit_relations"], "readwrite");
    const eventsStore = tx.objectStore("events");
    const checkpointsStore = tx.objectStore("checkpoints");
    const redactedStore = tx.objectStore("redacted");

    const insertPromises: Array<Promise<boolean>> = [];
    for (const item of events) {
        if (!item.event.event_id) continue;
        if (isEventTooOld(item.event, cutoffTs)) continue;
        insertPromises.push(
            (async () => {
                if (await requestToPromise(redactedStore.get(item.event.event_id))) return false;
                const record = await projectLatestEdit(tx, makeEventRecord(item.event, item.profile));
                return addRecord(eventsStore, record);
            })(),
        );
    }

    if (oldCheckpoint) {
        checkpointsStore.delete([oldCheckpoint.roomId, oldCheckpoint.token, oldCheckpoint.direction] as IDBValidKey);
    }

    if (checkpoint) {
        checkpointsStore.put({
            room_id: checkpoint.roomId,
            token: checkpoint.token,
            direction: checkpoint.direction,
            full_crawl: checkpoint.fullCrawl ? 1 : 0,
            root_token: checkpoint.rootToken,
        });
    }

    const insertResults = await Promise.all(insertPromises);
    const inserted = insertResults.filter(Boolean).length;

    await transactionDone(tx);
    return inserted === 0;
}

async function addCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
    const database = ensureDb();
    const tx = database.transaction("checkpoints", "readwrite");
    const store = tx.objectStore("checkpoints");
    store.put({
        room_id: checkpoint.roomId,
        token: checkpoint.token,
        direction: checkpoint.direction,
        full_crawl: checkpoint.fullCrawl ? 1 : 0,
        root_token: checkpoint.rootToken,
    });
    await transactionDone(tx);
}

async function removeCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
    const database = ensureDb();
    const tx = database.transaction("checkpoints", "readwrite");
    const store = tx.objectStore("checkpoints");
    store.delete([checkpoint.roomId, checkpoint.token, checkpoint.direction] as IDBValidKey);
    await transactionDone(tx);
}

// Read revisions in the same snapshot as the projected event, before advancing its cursor.
async function readFileEdits(tx: IDBTransaction, item: IEventAndProfile): Promise<void> {
    const candidates = (await requestToPromise(
        tx.objectStore("edit_relations").index("target_id").getAll(item.event.event_id),
    )) as Array<{
        event_id: string;
        room_id: string;
        sender: string;
        timestamp: number;
        content_json: string;
    }>;
    const valid = await Promise.all(
        candidates.map(async (candidate) =>
            candidate.room_id === item.event.room_id &&
            candidate.sender === item.event.sender &&
            !(await requestToPromise(tx.objectStore("redacted").get(candidate.event_id)))
                ? {
                      event_id: candidate.event_id,
                      room_id: candidate.room_id,
                      sender: candidate.sender,
                      timestamp: candidate.timestamp,
                      content: JSON.parse(candidate.content_json) as Record<string, unknown>,
                  }
                : null,
        ),
    );
    item.file_edits = valid.filter((entry) => entry !== null);
}

async function loadFileEvents(args: ILoadArgs): Promise<IEventAndProfile[]> {
    const roomId = args.roomId;
    const limit = args.limit ?? 10;
    const direction = args.direction ?? "b";

    let startKey: IDBValidKey | undefined;
    if (args.fromEvent) {
        const database = ensureDb();
        const tx = database.transaction("events", "readonly");
        const store = tx.objectStore("events");
        const record = await requestToPromise(store.get(args.fromEvent));
        await transactionDone(tx);
        if (record) startKey = [record.room_id, record.origin_server_ts ?? 0, record.event_id] as IDBValidKey;
    }

    const database = ensureDb();
    const tx = database.transaction(["events", "edit_relations", "redacted"], "readonly");
    const completed = transactionDone(tx);
    const store = tx.objectStore("events");
    const cursorDirection: IDBCursorDirection = direction === "b" ? "prev" : "next";
    const range = buildRoomRange(roomId, startKey, cursorDirection === "prev" ? "prev" : "next");
    const msgtypes = new Set(["m.file", "m.image", "m.video", "m.audio"]);
    const results: IEventAndProfile[] = [];
    const revisions: Promise<void>[] = [];

    const index = store.index("room_ts");
    await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(range, cursorDirection);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || results.length >= limit) {
                resolve();
                return;
            }
            const record = cursor.value as EventRecord;
            if (msgtypes.has(record.msgtype ?? "")) {
                const item: IEventAndProfile = {
                    event: JSON.parse(record.event_json) as IEventWithRoomId,
                    original_event: record.original_event_json
                        ? (JSON.parse(record.original_event_json) as IEventWithRoomId)
                        : undefined,
                    profile: record.profile_json ? (JSON.parse(record.profile_json) as IMatrixProfile) : {},
                };
                results.push(item);
                revisions.push(readFileEdits(tx, item));
            }
            cursor.continue();
        };
    });

    await Promise.all(revisions);
    await completed;
    return results;
}

// Use the existing per-type index; keep one opaque cursor per message type so two streams merge in timestamp order.
async function queryFileEvents(args: IFileQuery): Promise<IFileQueryPage> {
    const categoryTypes = args.category === "media" ? ["m.image", "m.video"] : ["m.file", "m.audio"];
    if (args.msgtype && !categoryTypes.includes(args.msgtype)) return { events: [], exhausted: true };
    if (
        (args.fromTs !== undefined && !Number.isFinite(args.fromTs)) ||
        (args.toTs !== undefined && !Number.isFinite(args.toTs)) ||
        (args.fromTs !== undefined && args.toTs !== undefined && args.fromTs >= args.toTs)
    ) {
        return { events: [], exhausted: true };
    }
    const types = args.msgtype ? [args.msgtype] : categoryTypes;
    const starts: Record<string, IDBValidKey | undefined> = {};
    if (args.cursor) {
        try {
            const parsed: unknown = JSON.parse(args.cursor);
            if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor");
            if (
                "key" in parsed &&
                Array.isArray(parsed.key) &&
                parsed.key.length === 3 &&
                parsed.key[0] === args.roomId &&
                typeof parsed.key[1] === "number" &&
                typeof parsed.key[2] === "string"
            ) {
                // Cursors from the earlier room_ts scan continue without re-reading newer records.
                for (const type of types) starts[type] = [args.roomId, type, parsed.key[1], parsed.key[2]];
            } else if ("byType" in parsed && parsed.byType && typeof parsed.byType === "object") {
                for (const type of types) {
                    const key = (parsed.byType as Record<string, unknown>)[type];
                    if (key === undefined) continue;
                    if (
                        !Array.isArray(key) ||
                        key.length !== 4 ||
                        key[0] !== args.roomId ||
                        key[1] !== type ||
                        typeof key[2] !== "number" ||
                        typeof key[3] !== "string"
                    )
                        throw new Error("Invalid cursor");
                    starts[type] = key;
                }
            } else {
                throw new Error("Invalid cursor");
            }
        } catch {
            throw new WebEventIndexError({
                code: "cursor_unavailable",
                operation: "queryFileEvents",
                retryability: "reinitialize",
            });
        }
    }

    const tx = ensureDb().transaction(["events", "edit_relations", "redacted"], "readonly");
    const index = tx.objectStore("events").index("room_msgtype_ts");
    const completed = transactionDone(tx);
    const requests = types.map((type) => {
        const lower = [args.roomId, type, args.fromTs ?? 0, ""] as IDBValidKey;
        const upper = starts[type] ?? ([args.roomId, type, args.toTs ?? MAX_TS, MAX_EVENT_ID] as IDBValidKey);
        const range = IDBKeyRange.bound(lower, upper, false, Boolean(starts[type]));
        return index.openCursor(range, "prev");
    });
    const cursors = await Promise.all(requests.map((request) => requestToPromise(request)));

    const events: IEventAndProfile[] = [];
    const revisions: Promise<void>[] = [];
    const term = args.term.trim().toLowerCase();
    const lastKeys = { ...starts };
    let scanned = 0;
    while (scanned < MAX_SCAN_RECORDS && events.length < Math.max(1, args.limit)) {
        const a = cursors[0]?.value as EventRecord | undefined;
        const b = cursors[1]?.value as EventRecord | undefined;
        if (!a && !b) break;
        const indexToRead =
            !b ||
            (a && (a.origin_server_ts ?? 0) > (b.origin_server_ts ?? 0)) ||
            (a && a.origin_server_ts === b.origin_server_ts && a.event_id > b.event_id)
                ? 0
                : 1;
        const cursor = cursors[indexToRead]!;
        const record = cursor.value as EventRecord;
        const type = types[indexToRead];
        lastKeys[type] = [args.roomId, type, record.origin_server_ts ?? 0, record.event_id];
        scanned++;
        const event = JSON.parse(record.event_json) as IEventWithRoomId;
        const content = (event as IEventWithRoomId & { content?: { filename?: string; body?: string } }).content;
        if (
            (!args.sender || (record.sender ?? event.sender) === args.sender) &&
            (args.toTs === undefined || (record.origin_server_ts ?? 0) < args.toTs) &&
            (!term ||
                [content?.filename, content?.body].some(
                    (name) => typeof name === "string" && name.toLowerCase().includes(term),
                ))
        ) {
            const item: IEventAndProfile = {
                event,
                original_event: record.original_event_json
                    ? (JSON.parse(record.original_event_json) as IEventWithRoomId)
                    : undefined,
                profile: record.profile_json ? JSON.parse(record.profile_json) : {},
            };
            events.push(item);
            revisions.push(readFileEdits(tx, item));
        }
        if (events.length >= Math.max(1, args.limit) || scanned >= MAX_SCAN_RECORDS) break;
        const next = requestToPromise(requests[indexToRead]);
        cursor.continue();
        cursors[indexToRead] = await next;
    }
    const exhausted =
        cursors.every((cursor) => !cursor) && events.length < Math.max(1, args.limit) && scanned < MAX_SCAN_RECORDS;
    await Promise.all(revisions);
    await completed;
    return { events, cursor: JSON.stringify({ byType: lastKeys }), exhausted };
}

async function loadCheckpoints(): Promise<ICrawlerCheckpoint[]> {
    const database = ensureDb();
    const tx = database.transaction("checkpoints", "readonly");
    const store = tx.objectStore("checkpoints");
    const results = await requestToPromise(store.getAll());
    await transactionDone(tx);

    return (
        results as Array<{
            room_id: string;
            token: string;
            direction: string;
            full_crawl?: number;
            root_token?: string;
        }>
    ).map((row) => ({
        roomId: row.room_id,
        token: row.token,
        direction: row.direction as any,
        fullCrawl: row.full_crawl === 1,
        rootToken: row.root_token,
    }));
}

async function getCompletedRoomToken(roomId: string): Promise<string | null> {
    const tx = ensureDb().transaction("meta", "readonly");
    const row = await requestToPromise(tx.objectStore("meta").get(`completed-room:${roomId}`));
    await transactionDone(tx);
    return typeof row?.value === "string" ? row.value : null;
}

async function markRoomHistoryComplete(roomId: string, token: string): Promise<void> {
    const tx = ensureDb().transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: `completed-room:${roomId}`, value: token });
    await transactionDone(tx);
}

async function closeEventIndex(): Promise<void> {
    eventIndexDatabase.close();
}

async function getStats(): Promise<IIndexStats> {
    const database = ensureDb();
    const countTx = database.transaction("events", "readonly");
    const countStore = countTx.objectStore("events");
    const count = await requestToPromise(countStore.count());
    await transactionDone(countTx);

    let roomCount = 0;
    const roomTx = database.transaction("events", "readonly");
    const roomStore = roomTx.objectStore("events");
    const index = roomStore.index("room_id");
    await new Promise<void>((resolve, reject) => {
        const request = index.openKeyCursor(null, "nextunique");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            roomCount += 1;
            cursor.continue();
        };
    });

    await transactionDone(roomTx);

    return {
        size: 0,
        eventCount: count,
        roomCount,
    };
}

async function getUserVersion(): Promise<number> {
    const database = ensureDb();
    const tx = database.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const row = await requestToPromise(store.get("user_version"));
    await transactionDone(tx);
    return row?.value ?? 0;
}

async function setUserVersion(version: number): Promise<void> {
    const database = ensureDb();
    const tx = database.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    store.put({ key: "user_version", value: version });
    await transactionDone(tx);
}

async function getCompatibilityWarnings(): Promise<string[]> {
    const tx = ensureDb().transaction("meta", "readonly");
    const row = await requestToPromise(tx.objectStore("meta").get("legacy_unverified_edit_count"));
    await transactionDone(tx);
    return typeof row?.value === "number" && row.value > 0 ? ["legacy_edits_unverified"] : [];
}

async function deleteEventIndex(): Promise<void> {
    await eventIndexDatabase.delete();
}

const handlers = {
    supportsEventIndexing,
    initEventIndex,
    setMaxEventAgeDays,
    addEventToIndex,
    deleteEvent,
    applyEventEdit,
    isEventIndexEmpty,
    isRoomIndexed,
    commitLiveEvents,
    searchEventIndex,
    addHistoricEvents,
    addCrawlerCheckpoint,
    removeCrawlerCheckpoint,
    loadFileEvents,
    queryFileEvents,
    loadCheckpoints,
    getCompletedRoomToken,
    markRoomHistoryComplete,
    closeEventIndex,
    getStats,
    getUserVersion,
    setUserVersion,
    getCompatibilityWarnings,
    deleteEventIndex,
} satisfies Record<WebEventIndexWorkerOperation, (...args: any[]) => Promise<any>>;

// Serialize lifecycle operations with reads and writes: a queued account switch or close
// cannot run while an older request is still using the previous account's database.
let queue = Promise.resolve();
ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
    const { id, name, args } = event.data;
    queue = queue
        .then(async () => {
            const handler = handlers[name];
            if (!handler) throw new Error(`Unknown handler: ${name}`);
            const reply: unknown = await Reflect.apply(handler, undefined, args);
            ctx.postMessage({ id, reply });
        })
        .catch((error: unknown) => {
            const operation = Object.hasOwn(handlers, name) ? name : "rpc";
            ctx.postMessage({ id, error: WebEventIndexError.from(error, operation).toPayload() });
        });
};
