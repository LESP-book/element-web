/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import SdkConfig from "../../SdkConfig";
import BaseEventIndexManager, {
    type ICrawlerCheckpoint,
    type IEventAndProfile,
    type IIndexStats,
    type IFileQuery,
    type IFileQueryPage,
    type ILoadArgs,
    type ISearchArgs,
} from "../BaseEventIndexManager";
import type { IResultRoomEvents } from "matrix-js-sdk/src/matrix";
import workerFactory from "./webEventIndexWorkerFactory";
import { WebEventIndexError, type WebEventIndexOperation } from "./WebEventIndexError";

interface WorkerRequest {
    id: number;
    name: string;
    args: any[];
}

interface WorkerResponse {
    id: number;
    reply?: unknown;
    error?: unknown;
}

interface IndexIdentity {
    readonly userId: string;
    readonly deviceId: string;
}

interface WorkerBinding {
    readonly identity: IndexIdentity;
    readonly identityGeneration: number;
    readonly workerGeneration: number;
    readonly schemaSourceVersion: number | null;
    readonly state: "ready" | "closing" | "closed";
}

interface ReplacementIntent {
    readonly identity: IndexIdentity;
    readonly promise: Promise<void>;
    bindingGeneration?: number;
}

class WorkerRPC {
    private static readonly REQUEST_TIMEOUT_MS = 30_000;
    private worker: Worker;
    public generation = 0;
    private pending: Record<
        number,
        { resolve: (value: unknown) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout> }
    > = {};
    private idleWaiters: Array<() => void> = [];
    private nextId = 0;
    private failure: WebEventIndexError | null = null;

    public constructor() {
        this.worker = workerFactory({ type: "module" });
        this.attachWorker();
    }

    /** Retire and recreate a failed Worker generation, or report that the current generation is healthy. */
    public retireFailedGeneration(): "retired" | "not-failed" {
        if (!this.failure) return "not-failed";
        this.recreate();
        return "retired";
    }

    public recreate(): void {
        this.worker.terminate();
        const error = new WebEventIndexError({
            code: "worker_failure",
            operation: "worker",
            retryability: "reinitialize",
        });
        for (const pending of Object.values(this.pending)) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending = {};
        this.notifyIdle();
        this.generation++;
        this.failure = null;
        this.worker = workerFactory({ type: "module" });
        this.attachWorker();
    }

    private attachWorker(): void {
        this.worker.onmessage = this.onMessage;
        this.worker.onerror = () => {
            logger.error("WebEventIndex worker failed");
            this.fail(
                new WebEventIndexError({ code: "worker_failure", operation: "worker", retryability: "reinitialize" }),
            );
        };
        this.worker.onmessageerror = () =>
            this.fail(
                new WebEventIndexError({ code: "worker_failure", operation: "worker", retryability: "reinitialize" }),
            );
    }

    private fail(error: WebEventIndexError): void {
        if (this.failure) return;
        this.failure = error;
        this.worker.terminate();
        for (const pending of Object.values(this.pending)) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending = {};
        this.notifyIdle();
    }

    private notifyIdle(): void {
        if (Object.keys(this.pending).length !== 0) return;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
    }

    public waitForIdle(): Promise<void> {
        if (Object.keys(this.pending).length === 0) return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    public call<T = unknown>(name: string, ...args: any[]): Promise<T> {
        if (this.failure) return Promise.reject(this.failure);
        const id = ++this.nextId;
        const promise = new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                // Terminate the generation, not just this promise: the Worker may still be writing a cursor.
                this.fail(
                    new WebEventIndexError({
                        code: "worker_failure",
                        operation: "worker",
                        retryability: "reinitialize",
                    }),
                );
            }, WorkerRPC.REQUEST_TIMEOUT_MS);
            this.pending[id] = { resolve: (value) => resolve(value as T), reject, timer };
        });
        const payload: WorkerRequest = { id, name, args };
        try {
            this.worker.postMessage(payload);
        } catch (error) {
            clearTimeout(this.pending[id].timer);
            delete this.pending[id];
            this.notifyIdle();
            return Promise.reject(WebEventIndexError.from(error, "rpc"));
        }
        return promise;
    }

    private onMessage = (event: MessageEvent<WorkerResponse>): void => {
        const payload = event.data;
        if (!payload || typeof payload !== "object" || !Number.isInteger(payload.id)) {
            this.fail(
                new WebEventIndexError({ code: "worker_failure", operation: "worker", retryability: "reinitialize" }),
            );
            return;
        }
        const pending = this.pending[payload.id];
        if (!pending) {
            logger.warn("WebEventIndex worker replied with unknown id", payload.id);
            return;
        }
        clearTimeout(pending.timer);
        delete this.pending[payload.id];
        this.notifyIdle();
        if (payload.error !== undefined) {
            pending.reject(
                WebEventIndexError.fromPayload(payload.error) ??
                    new WebEventIndexError({ code: "unknown", operation: "rpc", retryability: "never" }),
            );
        } else {
            pending.resolve(payload.reply);
        }
    };
}

export class WebEventIndexManager extends BaseEventIndexManager {
    private readonly rpc = new WorkerRPC();
    private binding: WorkerBinding | null = null;
    private nextBindingGeneration = 0;
    private replacementIntent: ReplacementIntent | null = null;
    private initializing: { identityGeneration: number; promise: Promise<void> } | null = null;
    private terminating: {
        identityGeneration: number;
        operation: "closeEventIndex" | "deleteEventIndex" | "replaceBinding";
        promise: Promise<void>;
    } | null = null;
    private maxEventAgeDays?: number;
    private recovery: { identityGeneration: number; promise: Promise<WorkerBinding> } | null = null;
    private recoveryFailure: {
        identityGeneration: number;
        workerGeneration: number;
        error: WebEventIndexError;
    } | null = null;

    private isCurrentIdentity(identity: IndexIdentity, generation: number): boolean {
        const binding = this.binding;
        return Boolean(
            binding &&
            binding.state === "ready" &&
            binding.identity === identity &&
            binding.identityGeneration === generation,
        );
    }

    private isSameWorkerBinding(binding: WorkerBinding): boolean {
        const current = this.binding;
        return Boolean(
            current &&
            current.identity === binding.identity &&
            current.identityGeneration === binding.identityGeneration &&
            current.workerGeneration === binding.workerGeneration &&
            this.rpc.generation === binding.workerGeneration,
        );
    }

    private isCurrentBinding(binding: WorkerBinding): boolean {
        return this.isSameWorkerBinding(binding) && this.binding?.state !== "closed";
    }

    private accountChangedError(operation: WebEventIndexOperation): WebEventIndexError {
        return new WebEventIndexError({ code: "cancelled", operation, retryability: "never" });
    }

    private isInitializationOperation(binding: WorkerBinding, name: WebEventIndexOperation): boolean {
        return (
            this.initializing?.identityGeneration === binding.identityGeneration &&
            (name === "initEventIndex" || name === "setMaxEventAgeDays")
        );
    }

    private updateSchemaSourceVersion(binding: WorkerBinding, sourceVersion: number): void {
        if (!this.isCurrentBinding(binding)) throw this.accountChangedError("initEventIndex");
        this.binding = { ...binding, schemaSourceVersion: sourceVersion };
    }

    /** Replace the RPC Worker and advance its generation; callers own lifecycle serialization. */
    private recreateWorker(): void {
        this.rpc.recreate();
    }

    private recoverWorker(binding: WorkerBinding): Promise<WorkerBinding> {
        const { identity, identityGeneration } = binding;
        if (this.terminating?.identityGeneration === identityGeneration) {
            return Promise.reject(this.accountChangedError("worker"));
        }
        if (!this.isCurrentIdentity(identity, identityGeneration)) {
            return Promise.reject(this.accountChangedError("worker"));
        }
        if (this.recovery?.identityGeneration === identityGeneration) return this.recovery.promise;
        if (
            this.recoveryFailure?.identityGeneration === identityGeneration &&
            this.recoveryFailure.workerGeneration === this.rpc.generation
        ) {
            return Promise.reject(this.recoveryFailure.error);
        }
        if (!this.isCurrentBinding(binding)) return Promise.reject(this.accountChangedError("worker"));

        let recoveredBinding: WorkerBinding | null = null;
        const promise: Promise<WorkerBinding> = (async (): Promise<WorkerBinding> => {
            if (this.terminating?.identityGeneration === identityGeneration || !this.isCurrentBinding(binding)) {
                throw this.accountChangedError("worker");
            }
            this.recreateWorker();
            recoveredBinding = {
                identity,
                identityGeneration,
                workerGeneration: this.rpc.generation,
                schemaSourceVersion: null,
                state: "ready",
            };
            this.binding = recoveredBinding;
            const sourceVersion = await this.rpc.call<number>("initEventIndex", identity.userId, identity.deviceId);
            if (!this.isCurrentBinding(recoveredBinding)) throw this.accountChangedError("worker");
            if (typeof sourceVersion !== "number") {
                throw new WebEventIndexError({ code: "unknown", operation: "initEventIndex", retryability: "never" });
            }
            recoveredBinding = { ...recoveredBinding, schemaSourceVersion: sourceVersion };
            this.binding = recoveredBinding;

            if (typeof this.maxEventAgeDays === "number") {
                await this.rpc.call<void>("setMaxEventAgeDays", this.maxEventAgeDays);
            }
            if (!this.isCurrentBinding(recoveredBinding)) throw this.accountChangedError("worker");
            return recoveredBinding;
        })()
            .catch((error: unknown) => {
                const current = this.binding;
                if (
                    !current ||
                    current.identityGeneration !== identityGeneration ||
                    current.state !== "ready" ||
                    this.rpc.generation !== current.workerGeneration
                ) {
                    throw this.accountChangedError("worker");
                }
                const recoveryError = WebEventIndexError.from(error, "initEventIndex");
                this.recoveryFailure = {
                    identityGeneration,
                    workerGeneration: current.workerGeneration,
                    error: recoveryError,
                };
                throw recoveryError;
            })
            .finally(() => {
                if (this.recovery?.promise === promise) this.recovery = null;
            });
        this.recovery = { identityGeneration, promise };
        return promise;
    }

    private async call<T>(name: WebEventIndexOperation, ...args: any[]): Promise<T> {
        let binding = this.binding;
        if (!binding) {
            if (name === "supportsEventIndexing") {
                const terminating = this.terminating;
                return terminating
                    ? terminating.promise.then(() => this.call<T>(name, ...args))
                    : this.rpc.call<T>(name, ...args);
            }
            throw this.accountChangedError(name);
        }
        if (binding.state !== "ready" && name !== "initEventIndex") throw this.accountChangedError(name);
        if (
            this.terminating?.identityGeneration === binding.identityGeneration &&
            !this.isInitializationOperation(binding, name)
        ) {
            throw this.accountChangedError(name);
        }

        if (this.recovery?.identityGeneration === binding.identityGeneration) {
            await this.recovery.promise;
            binding = this.binding;
            if (!binding) throw this.accountChangedError(name);
        }
        if (
            this.terminating?.identityGeneration === binding.identityGeneration &&
            !this.isInitializationOperation(binding, name)
        ) {
            throw this.accountChangedError(name);
        }
        if (!this.isCurrentIdentity(binding.identity, binding.identityGeneration)) throw this.accountChangedError(name);
        if (
            this.recoveryFailure?.identityGeneration === binding.identityGeneration &&
            this.recoveryFailure.workerGeneration === binding.workerGeneration &&
            name !== "initEventIndex"
        ) {
            throw this.recoveryFailure.error;
        }
        if (!this.isCurrentBinding(binding)) throw this.accountChangedError(name);

        try {
            const result = await this.rpc.call<T>(name, ...args);
            if (!this.isCurrentBinding(binding)) throw this.accountChangedError(name);
            if (name === "initEventIndex" && typeof result === "number") {
                this.updateSchemaSourceVersion(binding, result);
            }
            return result;
        } catch (error) {
            const indexError = WebEventIndexError.from(error, name);
            if (indexError.code !== "worker_failure") throw indexError;
            if (this.terminating?.identityGeneration === binding.identityGeneration) {
                throw this.accountChangedError(name);
            }
            if (!this.isCurrentIdentity(binding.identity, binding.identityGeneration)) {
                throw this.accountChangedError(name);
            }

            let recoveredBinding: WorkerBinding;
            if (this.rpc.generation === binding.workerGeneration) {
                recoveredBinding = await this.recoverWorker(binding);
            } else if (this.recovery?.identityGeneration === binding.identityGeneration) {
                recoveredBinding = await this.recovery.promise;
            } else {
                const current = this.binding;
                if (
                    !current ||
                    current.identityGeneration !== binding.identityGeneration ||
                    current.state !== "ready" ||
                    current.workerGeneration !== this.rpc.generation
                ) {
                    throw this.accountChangedError(name);
                }
                recoveredBinding = current;
            }
            if (this.terminating?.identityGeneration === binding.identityGeneration) {
                throw this.accountChangedError(name);
            }
            if (!this.isCurrentBinding(recoveredBinding)) throw this.accountChangedError(name);
            if (name === "initEventIndex") return recoveredBinding.schemaSourceVersion as T;

            const result = await this.rpc.call<T>(name, ...args);
            if (!this.isCurrentBinding(recoveredBinding)) throw this.accountChangedError(name);
            return result;
        }
    }

    public async supportsEventIndexing(): Promise<boolean> {
        // The capability probe only checks Worker/IndexedDB availability and does not access an account database.
        try {
            return await this.call<boolean>("supportsEventIndexing");
        } catch (e) {
            logger.warn("WebEventIndex supportsEventIndexing failed", e);
            return false;
        }
    }

    public initEventIndex(userId: string, deviceId: string): Promise<void> {
        const terminating = this.terminating;
        if (terminating) return terminating.promise.then(() => this.initEventIndex(userId, deviceId));

        const previous = this.binding;
        if (
            previous &&
            (previous.state !== "ready" ||
                previous.identity.userId !== userId ||
                previous.identity.deviceId !== deviceId)
        ) {
            const identity: IndexIdentity = Object.freeze({ userId, deviceId });
            const promise = this.replaceBinding(previous)
                .then(() => this.initEventIndex(userId, deviceId))
                .finally(() => {
                    if (this.replacementIntent?.promise === promise) this.replacementIntent = null;
                });
            this.replacementIntent = { identity, promise };
            return promise;
        }
        const changed = !previous;
        if (changed) {
            this.binding = {
                identity: Object.freeze({ userId, deviceId }),
                identityGeneration: ++this.nextBindingGeneration,
                workerGeneration: this.rpc.generation,
                schemaSourceVersion: null,
                state: "ready",
            };
            const replacement = this.replacementIntent;
            if (replacement?.identity.userId === userId && replacement.identity.deviceId === deviceId) {
                replacement.bindingGeneration = this.binding.identityGeneration;
            }
            this.recovery = null;
            this.recoveryFailure = null;
        }

        const binding = this.binding;
        if (!binding || binding.state !== "ready") return Promise.reject(this.accountChangedError("initEventIndex"));
        const initializing = this.initializing;
        if (initializing?.identityGeneration === binding.identityGeneration) return initializing.promise;

        const promise = this.initializeBinding(binding, userId, deviceId).finally(() => {
            if (this.initializing?.promise === promise) this.initializing = null;
        });
        this.initializing = { identityGeneration: binding.identityGeneration, promise };
        return promise;
    }

    private async initializeBinding(binding: WorkerBinding, userId: string, deviceId: string): Promise<void> {
        const previousRecovery = this.recovery;
        if (previousRecovery?.identityGeneration === binding.identityGeneration) {
            await previousRecovery.promise.catch(() => {});
        }
        if (!this.isCurrentIdentity(binding.identity, binding.identityGeneration)) {
            throw this.accountChangedError("initEventIndex");
        }
        if (this.recoveryFailure?.identityGeneration === binding.identityGeneration) this.recoveryFailure = null;

        const days = SdkConfig.get("local_event_index_max_event_age_days");
        this.maxEventAgeDays = typeof days === "number" ? days : undefined;
        const sourceVersion = await this.call<number>("initEventIndex", userId, deviceId);
        if (typeof sourceVersion !== "number") {
            throw new WebEventIndexError({ code: "unknown", operation: "initEventIndex", retryability: "never" });
        }
        if (!this.isCurrentIdentity(binding.identity, binding.identityGeneration)) {
            throw this.accountChangedError("initEventIndex");
        }
        if (typeof days === "number") await this.call<void>("setMaxEventAgeDays", days);
        if (!this.isCurrentIdentity(binding.identity, binding.identityGeneration)) {
            throw this.accountChangedError("initEventIndex");
        }
    }

    /** Only validated schema generations with a tested event-record layout may upgrade v0 metadata. */
    public canUpgradeUserVersion(from: number, to: number): boolean {
        const binding = this.binding;
        return (
            !this.terminating &&
            Boolean(binding && binding.state === "ready" && binding.workerGeneration === this.rpc.generation) &&
            from === 0 &&
            to === 1 &&
            (binding?.schemaSourceVersion === 2 || binding?.schemaSourceVersion === 3)
        );
    }

    public async getCompatibilityWarnings(): Promise<string[]> {
        return this.call<string[]>("getCompatibilityWarnings");
    }

    public async addEventToIndex(ev: IEventAndProfile["event"], profile: IEventAndProfile["profile"]): Promise<void> {
        return this.call<void>("addEventToIndex", ev, profile);
    }

    public async deleteEvent(eventId: string): Promise<boolean> {
        return this.call<boolean>("deleteEvent", eventId);
    }

    public async applyEventEdit(editEvent: IEventAndProfile["event"]): Promise<void> {
        return this.call<void>("applyEventEdit", editEvent);
    }

    public async isEventIndexEmpty(): Promise<boolean> {
        return this.call<boolean>("isEventIndexEmpty");
    }

    public async isRoomIndexed(roomId: string): Promise<boolean> {
        return this.call<boolean>("isRoomIndexed", roomId);
    }

    public async commitLiveEvents(): Promise<void> {
        return this.call<void>("commitLiveEvents");
    }

    public supportsLocalUnencryptedRoomSearch(): boolean {
        return true;
    }

    public supportsFilteredFileQuery(): boolean {
        return true;
    }

    public async queryFileEvents(query: IFileQuery): Promise<IFileQueryPage> {
        return this.call<IFileQueryPage>("queryFileEvents", query);
    }

    public async searchEventIndex(searchArgs: ISearchArgs): Promise<IResultRoomEvents> {
        return this.call<IResultRoomEvents>("searchEventIndex", searchArgs);
    }

    public async addHistoricEvents(
        events: IEventAndProfile[],
        checkpoint: ICrawlerCheckpoint | null,
        oldCheckpoint: ICrawlerCheckpoint | null,
    ): Promise<boolean> {
        return this.call<boolean>("addHistoricEvents", events, checkpoint, oldCheckpoint);
    }

    public async addCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        return this.call<void>("addCrawlerCheckpoint", checkpoint);
    }

    public async removeCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        return this.call<void>("removeCrawlerCheckpoint", checkpoint);
    }

    public async loadFileEvents(args: ILoadArgs): Promise<IEventAndProfile[]> {
        return this.call<IEventAndProfile[]>("loadFileEvents", args);
    }

    public async loadCheckpoints(): Promise<ICrawlerCheckpoint[]> {
        return this.call<ICrawlerCheckpoint[]>("loadCheckpoints");
    }

    public async getCompletedRoomToken(roomId: string): Promise<string | null> {
        return this.call<string | null>("getCompletedRoomToken", roomId);
    }

    public async markRoomHistoryComplete(roomId: string, token: string): Promise<void> {
        return this.call<void>("markRoomHistoryComplete", roomId, token);
    }

    private replaceBinding(previous: WorkerBinding): Promise<void> {
        const identityGeneration = previous.identityGeneration;
        const promise: Promise<void> = Promise.resolve()
            .then(async (): Promise<void> => {
                const initialization = this.initializing;
                if (initialization?.identityGeneration === identityGeneration) {
                    await initialization.promise.catch(() => {});
                }
                let binding = this.binding;
                if (!binding || binding.identityGeneration !== identityGeneration) {
                    throw this.accountChangedError("initEventIndex");
                }

                const recovery = this.recovery;
                if (recovery?.identityGeneration === identityGeneration) await recovery.promise.catch(() => {});
                binding = this.binding;
                if (!binding || binding.identityGeneration !== identityGeneration) {
                    throw this.accountChangedError("initEventIndex");
                }
                const bindingBeforeRetirement = binding;
                // A failed or uninitialized Worker cannot authoritatively close this database; retire its generation instead.
                const recoveryFailed =
                    this.recoveryFailure?.identityGeneration === identityGeneration &&
                    this.recoveryFailure.workerGeneration === this.rpc.generation;
                const shouldClose =
                    binding.state === "ready" &&
                    binding.workerGeneration === this.rpc.generation &&
                    binding.schemaSourceVersion !== null &&
                    !recoveryFailed;

                // Let old-account RPCs finish at the Worker, but discard replies once the binding is retired.
                const workerGeneration = this.rpc.generation;
                this.binding = {
                    ...binding,
                    workerGeneration,
                    schemaSourceVersion: null,
                    state: "closed",
                };
                this.recovery = null;
                this.recoveryFailure = null;
                await this.rpc.waitForIdle();

                binding = this.binding;
                if (
                    !binding ||
                    binding.identityGeneration !== identityGeneration ||
                    binding.state !== "closed" ||
                    binding.workerGeneration !== workerGeneration ||
                    this.rpc.generation !== workerGeneration
                ) {
                    throw this.accountChangedError("initEventIndex");
                }

                let closeError: WebEventIndexError | undefined;
                if (shouldClose) {
                    try {
                        await this.rpc.call<void>("closeEventIndex");
                    } catch (error) {
                        closeError = WebEventIndexError.from(error, "closeEventIndex");
                    }
                }
                if (closeError) {
                    if (this.rpc.retireFailedGeneration() === "retired") {
                        // Worker termination retires A's generation; this switch proceeds without claiming close RPC success.
                        this.binding = null;
                        return;
                    }
                    // Keep A bound so a later attempt must retry its close instead of silently switching to B.
                    this.binding = bindingBeforeRetirement;
                    throw closeError;
                }
                this.recreateWorker();
                this.binding = null;
            })
            .finally(() => {
                if (this.terminating?.promise === promise) this.terminating = null;
            });
        // Reserve before returning so same-turn init/close calls share this lifecycle transition.
        this.terminating = { identityGeneration, operation: "replaceBinding", promise };
        return promise;
    }

    private terminateAfterReplacement(
        operation: "closeEventIndex" | "deleteEventIndex",
        replacement: ReplacementIntent,
    ): Promise<void> {
        const terminateTarget = (): Promise<void> => {
            const binding = this.binding;
            if (
                replacement.bindingGeneration === undefined ||
                binding?.identityGeneration !== replacement.bindingGeneration ||
                binding.state !== "ready" ||
                this.terminating?.operation === "replaceBinding" ||
                (this.replacementIntent !== null && this.replacementIntent !== replacement)
            ) {
                throw this.accountChangedError(operation);
            }
            return this.terminateBinding(operation, replacement.bindingGeneration);
        };
        // Even if setup failed after opening B, only the captured B generation may be cleaned up.
        return replacement.promise.then(terminateTarget, (error: unknown) => {
            if (this.binding?.identityGeneration === replacement.bindingGeneration) return terminateTarget();
            throw error;
        });
    }

    private terminateBinding(
        operation: "closeEventIndex" | "deleteEventIndex",
        expectedGeneration?: number,
    ): Promise<void> {
        if (
            expectedGeneration !== undefined &&
            (this.binding?.identityGeneration !== expectedGeneration ||
                this.binding.state !== "ready" ||
                this.terminating?.operation === "replaceBinding")
        ) {
            return Promise.reject(this.accountChangedError(operation));
        }
        const replacement = this.replacementIntent;
        if (replacement && expectedGeneration === undefined) {
            const binding = this.binding;
            if (
                !binding ||
                replacement.bindingGeneration === undefined ||
                binding.identityGeneration !== replacement.bindingGeneration
            ) {
                if (this.terminating?.operation !== "replaceBinding") {
                    return Promise.reject(this.accountChangedError(operation));
                }
                // Wait for the requested account, never whichever binding is current after another switch.
                return this.terminateAfterReplacement(operation, replacement);
            }
        }

        const terminating = this.terminating;
        if (terminating) {
            return terminating.operation === operation
                ? terminating.promise
                : terminating.promise.then(() => this.terminateBinding(operation, expectedGeneration));
        }
        const initialBinding = this.binding;
        if (!initialBinding) {
            // With no binding or pending account switch, there is no user database; close/delete intentionally do nothing.
            return Promise.resolve();
        }
        const identityGeneration = initialBinding.identityGeneration;

        const promise: Promise<void> = Promise.resolve()
            .then(async (): Promise<void> => {
                const initialization = this.initializing;
                if (initialization?.identityGeneration === identityGeneration) {
                    // Close/delete are safe after partial initialization, even if no schema version was returned.
                    await initialization.promise.catch(() => {});
                }
                let binding = this.binding;
                if (!binding || binding.identityGeneration !== identityGeneration) {
                    throw this.accountChangedError(operation);
                }

                const recovery = this.recovery;
                if (recovery?.identityGeneration === identityGeneration) await recovery.promise.catch(() => {});
                await this.rpc.waitForIdle();

                binding = this.binding;
                if (
                    !binding ||
                    binding.identityGeneration !== identityGeneration ||
                    binding.workerGeneration !== this.rpc.generation
                ) {
                    throw this.accountChangedError(operation);
                }
                if (binding.state === "closed" && operation === "closeEventIndex") return;
                if (binding.state !== "ready" && binding.state !== "closed") {
                    throw this.accountChangedError(operation);
                }

                const bindingBeforeClose = binding;
                const closingBinding: WorkerBinding = { ...binding, state: "closing" };
                this.binding = closingBinding;
                this.recovery = null;
                this.recoveryFailure = null;
                try {
                    await this.rpc.call<void>(operation);
                    if (!this.isSameWorkerBinding(closingBinding) || this.binding !== closingBinding) {
                        throw this.accountChangedError(operation);
                    }
                    this.binding = {
                        ...closingBinding,
                        identityGeneration: ++this.nextBindingGeneration,
                        schemaSourceVersion: null,
                        state: "closed",
                    };
                } catch (error) {
                    if (this.binding === closingBinding) this.binding = bindingBeforeClose;
                    throw WebEventIndexError.from(error, operation);
                }
            })
            .finally(() => {
                if (this.terminating?.promise === promise) this.terminating = null;
            });
        // Reserve before returning so same-turn init/close calls share this lifecycle transition.
        this.terminating = { identityGeneration, operation, promise };
        return promise;
    }

    public async closeEventIndex(): Promise<void> {
        return this.terminateBinding("closeEventIndex");
    }

    public async getStats(): Promise<IIndexStats> {
        return this.call<IIndexStats>("getStats");
    }

    public async getUserVersion(): Promise<number> {
        return this.call<number>("getUserVersion");
    }

    public async setUserVersion(version: number): Promise<void> {
        return this.call<void>("setUserVersion", version);
    }

    public async deleteEventIndex(): Promise<void> {
        return this.terminateBinding("deleteEventIndex");
    }
}
