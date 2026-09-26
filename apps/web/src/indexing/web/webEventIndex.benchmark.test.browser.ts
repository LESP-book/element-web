/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it } from "vitest";

import SdkConfig from "../../SdkConfig";
import { WebEventIndexManager } from "./WebEventIndexManager";
import { makeEventRecord } from "./webEventEditStore";

// Opt in explicitly: 110,000 browser IndexedDB records are too expensive for normal CI.
describe.skipIf(
    (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_SEARCH_BENCHMARK !== "1",
)("Chromium search baseline", () => {
    beforeEach(() => SdkConfig.reset());
    it.each([10_000, 100_000])(
        "measures bounded queries across %i indexed events",
        async (count) => {
            const userId = `@benchmark-${crypto.randomUUID()}:example.org`;
            const deviceId = "isolated-benchmark";
            const roomId = "!benchmark:example.org";
            const encode = (value: string): string => encodeURIComponent(value).replace(/%/g, "_");
            const databaseName = `element-web-event-index-${encode(userId)}-${encode(deviceId)}`;
            const manager = new WebEventIndexManager();
            try {
                await manager.initEventIndex(userId, deviceId);
                await manager.closeEventIndex();
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open(databaseName);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                try {
                    for (let offset = 0; offset < count; offset += 500) {
                        const tx = db.transaction("events", "readwrite");
                        const store = tx.objectStore("events");
                        const finished = new Promise<void>((resolve, reject) => {
                            tx.oncomplete = () => resolve();
                            tx.onabort = () => reject(tx.error);
                            tx.onerror = () => reject(tx.error);
                        });
                        for (let i = offset; i < Math.min(offset + 500, count); i++) {
                            const attachment = i % 500 === 0;
                            store.put(
                                makeEventRecord(
                                    {
                                        event_id: `$benchmark-${i}`,
                                        room_id: roomId,
                                        sender: "@benchmark:example.org",
                                        origin_server_ts: Date.now() - i * 1_000,
                                        type: "m.room.message",
                                        content: attachment
                                            ? {
                                                  msgtype: "m.file",
                                                  body: "attachment",
                                                  filename: i % 3_000 === 0 ? "合同.pdf" : "notes.pdf",
                                              }
                                            : {
                                                  msgtype: "m.text",
                                                  body:
                                                      i % 9_877 === 1
                                                          ? "罕见 中文"
                                                          : i % 100 === 0
                                                            ? "常见 中文"
                                                            : "ordinary text",
                                              },
                                    },
                                    {},
                                ),
                            );
                        }
                        await finished;
                    }
                } finally {
                    db.close();
                }

                // Cold means a fresh Worker connection, not a cold OS or browser disk cache.
                const measurements: Array<{
                    query: string;
                    fullScanMs: number;
                    firstPageColdMs: number;
                    firstPageWarmP95Ms: number;
                    pages: number;
                }> = [];
                for (const query of ["常见", "罕见", "中文", "no-match", "file:合同"] as const) {
                    const run = async (firstPageOnly = false): Promise<{ elapsed: number; pages: number }> => {
                        const started = performance.now();
                        let pages = 0;
                        if (query === "file:合同") {
                            let cursor: string | undefined;
                            for (;;) {
                                const page = await manager.queryFileEvents({
                                    roomId,
                                    category: "files",
                                    term: "合同",
                                    limit: 20,
                                    cursor,
                                });
                                pages++;
                                if (firstPageOnly || page.exhausted) break;
                                cursor = page.cursor;
                            }
                        } else {
                            let nextBatch: string | undefined;
                            for (;;) {
                                const page = await manager.searchEventIndex({
                                    room_id: roomId,
                                    order_by_recency: true,
                                    search_term: query,
                                    limit: 20,
                                    before_limit: 0,
                                    after_limit: 0,
                                    next_batch: nextBatch,
                                });
                                pages++;
                                nextBatch = page.next_batch;
                                if (firstPageOnly || !nextBatch || JSON.parse(nextBatch).exhausted === true) break;
                            }
                        }
                        return { elapsed: performance.now() - started, pages };
                    };
                    await manager.initEventIndex(userId, deviceId);
                    const cold = await run(true);
                    const full = await run();
                    const warm: number[] = [];
                    for (let sample = 0; sample < 20; sample++) warm.push((await run(true)).elapsed);
                    warm.sort((a, b) => a - b);
                    measurements.push({
                        query,
                        fullScanMs: full.elapsed,
                        firstPageColdMs: cold.elapsed,
                        firstPageWarmP95Ms: warm[Math.ceil(warm.length * 0.95) - 1],
                        pages: full.pages,
                    });
                    await manager.closeEventIndex();
                }
                // Only synthetic query labels, counts and timings are logged; never real message data.
                console.info("Browser search baseline", { count, userAgent: navigator.userAgent, measurements });
                expect(
                    measurements.every((sample) => sample.pages > 0 && Number.isFinite(sample.firstPageWarmP95Ms)),
                ).toBe(true);
            } finally {
                await manager.closeEventIndex();
                // Only this test's random, isolated fixture database is removed.
                await new Promise<void>((resolve, reject) => {
                    const request = indexedDB.deleteDatabase(databaseName);
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                    request.onblocked = () => reject(new Error("Benchmark fixture database is still open"));
                });
            }
        },
        600_000,
    );
});
