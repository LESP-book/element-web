/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { requestToPromise, transactionDone } from "./webEventIndexIdb";
import { WebEventIndexError } from "./WebEventIndexError";

const DB_PREFIX = "element-web-event-index";
const DB_VERSION = 4;

const REQUIRED_STORES = {
    events: "event_id",
    checkpoints: ["room_id", "token", "direction"],
    meta: "key",
    redacted: "event_id",
    // Legacy v3 rows lack edit event, room and sender identity; preserve but never apply them.
    edits: "event_id",
    edit_relations: ["target_id", "event_id"],
} as const;

interface IndexSchema {
    keyPath: string | string[];
    unique?: boolean;
    multiEntry?: boolean;
}

const REQUIRED_INDEXES = {
    events: {
        room_id: { keyPath: "room_id" },
        room_ts: { keyPath: ["room_id", "origin_server_ts", "event_id"] },
        room_msgtype_ts: { keyPath: ["room_id", "msgtype", "origin_server_ts", "event_id"] },
    },
    edit_relations: {
        target_id: { keyPath: "target_id" },
        event_id: { keyPath: "event_id", unique: true },
    },
};

function encodeKeyPart(value: string): string {
    return encodeURIComponent(value).replace(/%/g, "_");
}

function buildDbName(userId: string, deviceId: string): string {
    return `${DB_PREFIX}-${encodeKeyPart(userId)}-${encodeKeyPart(deviceId)}`;
}

function matchesKeyPath(actual: string | string[] | null, expected: string | readonly string[]): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchesIndex(index: IDBIndex, schema: IndexSchema): boolean {
    return (
        matchesKeyPath(index.keyPath, schema.keyPath) &&
        index.unique === Boolean(schema.unique) &&
        index.multiEntry === Boolean(schema.multiEntry)
    );
}

function schemaError(): WebEventIndexError {
    return new WebEventIndexError({
        code: "schema_error",
        operation: "initEventIndex",
        retryability: "reinitialize",
    });
}

function ensureIndex(store: IDBObjectStore, name: string, schema: IndexSchema): void {
    if (store.indexNames.contains(name)) {
        if (matchesIndex(store.index(name), schema)) return;
        store.deleteIndex(name);
    }
    store.createIndex(name, schema.keyPath, { unique: schema.unique, multiEntry: schema.multiEntry });
}

function validateSchema(database: IDBDatabase): void {
    const stores = Object.keys(REQUIRED_STORES) as Array<keyof typeof REQUIRED_STORES>;
    if (stores.some((name) => !database.objectStoreNames.contains(name))) throw schemaError();

    const tx = database.transaction(stores, "readonly");
    for (const [name, keyPath] of Object.entries(REQUIRED_STORES) as Array<
        [keyof typeof REQUIRED_STORES, (typeof REQUIRED_STORES)[keyof typeof REQUIRED_STORES]]
    >) {
        if (!matchesKeyPath(tx.objectStore(name).keyPath, keyPath)) throw schemaError();
    }
    for (const [storeName, indexes] of Object.entries(REQUIRED_INDEXES) as Array<
        [keyof typeof REQUIRED_INDEXES, Record<string, IndexSchema>]
    >) {
        const store = tx.objectStore(storeName);
        if (
            Object.entries(indexes).some(
                ([name, schema]) => !store.indexNames.contains(name) || !matchesIndex(store.index(name), schema),
            )
        ) {
            throw schemaError();
        }
    }
}

/** Owns the non-destructive IndexedDB schema migration and connection lifecycle for one Worker. */
export class WebEventIndexDatabase {
    private database: IDBDatabase | null = null;
    private databaseName: string | null = null;
    private generation = 0;
    private opening: { name: string; generation: number; promise: Promise<number> } | null = null;
    private readonly pendingDeletes = new Set<string>();

    /** Get the open database, rejecting operations while its explicit delete is blocked. */
    public get(): IDBDatabase {
        if (this.databaseName && this.pendingDeletes.has(this.databaseName)) {
            throw new WebEventIndexError({
                code: "connection_blocked",
                operation: "rpc",
                retryability: "user_action",
            });
        }
        if (!this.database) throw new Error("Event index not initialized");
        return this.database;
    }

    /**
     * Open and validate the account/device database, adding only missing or rebuildable schema objects.
     * A newer identity supersedes an in-flight open; the stale caller receives a cancellation error.
     */
    public async init(userId: string, deviceId: string): Promise<number> {
        const name = buildDbName(userId, deviceId);
        if (this.pendingDeletes.has(name)) {
            throw new WebEventIndexError({
                code: "connection_blocked",
                operation: "initEventIndex",
                retryability: "user_action",
            });
        }
        if (this.database && this.databaseName === name) return this.database.version;
        if (this.opening?.name === name) {
            const { generation, promise } = this.opening;
            const sourceVersion = await promise;
            if (generation !== this.generation || this.databaseName !== name) {
                throw new WebEventIndexError({
                    code: "cancelled",
                    operation: "initEventIndex",
                    retryability: "never",
                });
            }
            return sourceVersion;
        }

        this.generation++;
        const generation = this.generation;
        this.database?.close();
        this.database = null;
        this.databaseName = name;
        const promise = this.open(name).then(({ database, sourceVersion }) => {
            if (generation !== this.generation || this.databaseName !== name) {
                database.close();
                throw new WebEventIndexError({
                    code: "cancelled",
                    operation: "initEventIndex",
                    retryability: "never",
                });
            }
            this.database = database;
            return sourceVersion;
        });
        const opening = { name, generation, promise };
        this.opening = opening;
        try {
            return await promise;
        } finally {
            if (this.opening === opening) this.opening = null;
        }
    }

    /** Close the current connection without deleting data or forgetting which account it belongs to. */
    public close(): void {
        this.generation++;
        this.opening = null;
        this.database?.close();
        this.database = null;
    }

    /** Delete only when explicitly requested, reporting blocked connections and tracking late completion. */
    public async delete(): Promise<void> {
        const name = this.databaseName;
        if (!name) return;
        this.close();

        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            let settled = false;
            request.onsuccess = () => {
                this.pendingDeletes.delete(name);
                if (this.databaseName === name) this.databaseName = null;
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            request.onerror = () => {
                this.pendingDeletes.delete(name);
                if (!settled) {
                    settled = true;
                    reject(WebEventIndexError.from(request.error, "deleteEventIndex"));
                }
            };
            request.onblocked = () => {
                this.pendingDeletes.add(name);
                if (!settled) {
                    settled = true;
                    reject(
                        new WebEventIndexError({
                            code: "connection_blocked",
                            operation: "deleteEventIndex",
                            retryability: "user_action",
                        }),
                    );
                }
            };
        });
    }

    private open(name: string): Promise<{ database: IDBDatabase; sourceVersion: number }> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(name, DB_VERSION);
            let settled = false;
            let migrationFailed = false;
            let sourceVersion: number | undefined;
            const fail = (error: unknown): void => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            request.onupgradeneeded = (event) => {
                const database = request.result;
                sourceVersion = event.oldVersion;
                const hasLegacyEdits = database.objectStoreNames.contains("edits");
                try {
                    for (const [storeName, keyPath] of Object.entries(REQUIRED_STORES) as Array<
                        [keyof typeof REQUIRED_STORES, (typeof REQUIRED_STORES)[keyof typeof REQUIRED_STORES]]
                    >) {
                        if (!database.objectStoreNames.contains(storeName)) {
                            database.createObjectStore(storeName, { keyPath: keyPath as string | string[] });
                        } else {
                            const store = request.transaction!.objectStore(storeName);
                            // Replacing a store would discard records; report malformed key paths without deleting data.
                            if (!matchesKeyPath(store.keyPath, keyPath)) throw schemaError();
                        }
                    }

                    for (const [storeName, indexes] of Object.entries(REQUIRED_INDEXES) as Array<
                        [keyof typeof REQUIRED_INDEXES, Record<string, IndexSchema>]
                    >) {
                        const store = request.transaction!.objectStore(storeName);
                        for (const [indexName, schema] of Object.entries(indexes))
                            ensureIndex(store, indexName, schema);
                    }

                    request.transaction!.objectStore("meta").put({
                        key: "schema_source_version",
                        value: sourceVersion,
                    });
                    if (hasLegacyEdits) {
                        const count = request.transaction!.objectStore("edits").count();
                        count.onsuccess = () => {
                            if (count.result > 0) {
                                request.transaction!.objectStore("meta").put({
                                    key: "legacy_unverified_edit_count",
                                    value: count.result,
                                });
                            }
                        };
                    }
                } catch {
                    migrationFailed = true;
                    request.transaction?.abort();
                }
            };
            request.onblocked = () =>
                fail(
                    new WebEventIndexError({
                        code: "connection_blocked",
                        operation: "initEventIndex",
                        retryability: "user_action",
                    }),
                );
            request.onsuccess = () => {
                const database = request.result;
                if (settled) {
                    database.close();
                    return;
                }
                let versionTransaction: IDBTransaction;
                let versionRow: Promise<{ value?: unknown } | undefined>;
                let versionTransactionDone: Promise<void>;
                try {
                    validateSchema(database);
                    versionTransaction = database.transaction("meta", "readonly");
                    versionRow = requestToPromise(versionTransaction.objectStore("meta").get("schema_source_version"));
                    versionTransactionDone = transactionDone(versionTransaction);
                } catch (error) {
                    database.close();
                    fail(error);
                    return;
                }
                database.onversionchange = () => {
                    database.close();
                    if (this.database === database) this.database = null;
                };
                Promise.all([versionRow, versionTransactionDone]).then(
                    ([row]) => {
                        if (settled) {
                            database.close();
                            return;
                        }
                        settled = true;
                        const storedVersion = row?.value;
                        resolve({
                            database,
                            sourceVersion: typeof storedVersion === "number" ? storedVersion : database.version,
                        });
                    },
                    (error: unknown) => {
                        database.close();
                        fail(WebEventIndexError.from(error, "initEventIndex"));
                    },
                );
            };
            request.onerror = () =>
                fail(migrationFailed ? schemaError() : WebEventIndexError.from(request.error, "initEventIndex"));
        });
    }
}
