/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { IEventWithRoomId, IMatrixProfile } from "matrix-js-sdk/src/matrix";

import { requestToPromise } from "./webEventIndexIdb";

interface EditRecord {
    target_id: string;
    event_id: string;
    room_id: string;
    sender: string;
    timestamp: number;
    content_json: string;
}

/** Stored event data used by search indexes and file queries. */
export interface EventRecord {
    event_id: string;
    room_id: string;
    sender?: string;
    origin_server_ts?: number;
    type?: string;
    msgtype?: string | null;
    body?: string;
    body_lower?: string;
    has_url?: boolean;
    event_json: string;
    original_event_json?: string;
    profile_json?: string;
}

const TEXT_MESSAGE_TYPES = new Set(["m.text", "m.notice", "m.emote"]);

function extractBody(event: IEventWithRoomId): string | null {
    if (event.type !== "m.room.message") return null;
    const content = event.content ?? {};
    const msgtype = content.msgtype;
    if (typeof msgtype !== "string" || !TEXT_MESSAGE_TYPES.has(msgtype)) return null;
    return typeof content.body === "string" ? content.body : null;
}

function hasUrl(content: Record<string, unknown>): boolean {
    const file = typeof content.file === "object" && content.file ? (content.file as Record<string, unknown>) : {};
    const info = typeof content.info === "object" && content.info ? (content.info as Record<string, unknown>) : {};
    const thumbnailFile =
        typeof info.thumbnail_file === "object" && info.thumbnail_file
            ? (info.thumbnail_file as Record<string, unknown>)
            : {};
    return Boolean(content.url || file.url || info.thumbnail_url || thumbnailFile.url);
}

/** Create the searchable record while retaining the unedited event for relation re-projection. */
export function makeEventRecord(event: IEventWithRoomId, profile: IMatrixProfile): EventRecord {
    const content = (event.content ?? {}) as Record<string, unknown>;
    const body = extractBody(event) ?? "";
    const eventJson = JSON.stringify(event);
    return {
        event_id: event.event_id,
        room_id: event.room_id,
        sender: event.sender,
        origin_server_ts: event.origin_server_ts ?? 0,
        type: event.type,
        msgtype: event.type === "m.room.message" && typeof content.msgtype === "string" ? content.msgtype : null,
        body,
        body_lower: body.toLowerCase(),
        has_url: hasUrl(content),
        event_json: eventJson,
        original_event_json: eventJson,
        profile_json: JSON.stringify(profile ?? {}),
    };
}

function withEditedContent(record: EventRecord, content: Record<string, unknown>): EventRecord {
    const originalEventJson = record.original_event_json ?? record.event_json;
    const event = JSON.parse(originalEventJson) as IEventWithRoomId;
    const profile = record.profile_json ? (JSON.parse(record.profile_json) as IMatrixProfile) : {};
    return { ...makeEventRecord({ ...event, content }, profile), original_event_json: originalEventJson };
}

/** Rebuild the event's search projection from its original content and current valid edits. */
export async function projectLatestEdit(tx: IDBTransaction, record: EventRecord): Promise<EventRecord> {
    const relations = tx.objectStore("edit_relations");
    const candidates = (await requestToPromise(
        relations.index("target_id").getAll(IDBKeyRange.only(record.event_id)),
    )) as EditRecord[];
    const redacted = tx.objectStore("redacted");
    const valid: EditRecord[] = [];

    for (const candidate of candidates) {
        if (
            record.type !== "m.room.message" ||
            candidate.room_id !== record.room_id ||
            candidate.sender !== record.sender ||
            (await requestToPromise(redacted.get(candidate.event_id)))
        ) {
            relations.delete([candidate.target_id, candidate.event_id]);
            continue;
        }
        valid.push(candidate);
    }

    const latest = valid.sort((a, b) => a.timestamp - b.timestamp || a.event_id.localeCompare(b.event_id)).at(-1);
    const originalEventJson = record.original_event_json ?? record.event_json;
    const originalEvent = JSON.parse(originalEventJson) as IEventWithRoomId;
    const profile = record.profile_json ? (JSON.parse(record.profile_json) as IMatrixProfile) : {};
    const baseRecord = { ...makeEventRecord(originalEvent, profile), original_event_json: originalEventJson };
    return latest ? withEditedContent(baseRecord, JSON.parse(latest.content_json)) : baseRecord;
}

/** Validate and persist an edit relation, including edits that arrive before their original event. */
export async function applyEventEditToIndex(tx: IDBTransaction, edit: IEventWithRoomId): Promise<void> {
    const content = edit.content as Record<string, unknown>;
    const relation = content?.["m.relates_to"] as Record<string, unknown> | undefined;
    const replacement = content?.["m.new_content"];
    const targetId = relation?.event_id;
    if (
        edit.type !== "m.room.message" ||
        relation?.rel_type !== "m.replace" ||
        typeof targetId !== "string" ||
        typeof edit.event_id !== "string" ||
        typeof edit.room_id !== "string" ||
        typeof edit.sender !== "string" ||
        typeof edit.origin_server_ts !== "number" ||
        !Number.isFinite(edit.origin_server_ts) ||
        !replacement ||
        typeof replacement !== "object" ||
        Array.isArray(replacement)
    ) {
        return;
    }

    const redacted = tx.objectStore("redacted");
    if ((await requestToPromise(redacted.get(edit.event_id))) || (await requestToPromise(redacted.get(targetId))))
        return;

    const events = tx.objectStore("events");
    const original = (await requestToPromise(events.get(targetId))) as EventRecord | undefined;
    if (
        original &&
        (original.type !== "m.room.message" || original.room_id !== edit.room_id || original.sender !== edit.sender)
    ) {
        return;
    }

    const relations = tx.objectStore("edit_relations");
    const existing = (await requestToPromise(relations.index("event_id").get(edit.event_id))) as EditRecord | undefined;
    if (!existing) {
        relations.put({
            target_id: targetId,
            event_id: edit.event_id,
            room_id: edit.room_id,
            sender: edit.sender,
            timestamp: edit.origin_server_ts,
            content_json: JSON.stringify(replacement),
        } satisfies EditRecord);
    }
    if (original) events.put(await projectLatestEdit(tx, original));
}

/** Remove a redacted event or edit relation and re-project the original when an edit was withdrawn. */
export async function deleteEventFromIndex(tx: IDBTransaction, eventId: string): Promise<void> {
    const events = tx.objectStore("events");
    const relations = tx.objectStore("edit_relations");
    const redacted = tx.objectStore("redacted");
    const original = (await requestToPromise(events.get(eventId))) as EventRecord | undefined;
    const edit = (await requestToPromise(relations.index("event_id").get(eventId))) as EditRecord | undefined;
    redacted.put({ event_id: eventId });

    if (original) {
        const dependentEdits = (await requestToPromise(
            relations.index("target_id").getAll(IDBKeyRange.only(eventId)),
        )) as EditRecord[];
        for (const dependentEdit of dependentEdits) relations.delete([dependentEdit.target_id, dependentEdit.event_id]);
        events.delete(eventId);
    } else if (edit) {
        relations.delete([edit.target_id, edit.event_id]);
        const target = (await requestToPromise(events.get(edit.target_id))) as EventRecord | undefined;
        if (target) events.put(await projectLatestEdit(tx, target));
    }
}
