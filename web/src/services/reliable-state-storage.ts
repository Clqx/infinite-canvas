import type { StateStorage } from "zustand/middleware";

import { getActiveLocalUserProfile, userScopedResourceName } from "@/services/local-user-profiles";

export type PersistencePhase = "hydrating" | "clean" | "scheduled" | "writing" | "retry-wait" | "error";

export type PersistenceStatus = {
    phase: PersistencePhase;
    ready: boolean;
    dirty: boolean;
    conflict: boolean;
    error: string;
    requestedRevision: number;
    durableRevision: number;
    lastSavedAt: string;
};

export type ReliableStateStorage = StateStorage & {
    flush: () => Promise<void>;
    retryNow: () => Promise<void>;
    markHydrated: () => boolean;
    markHydrationError: (error: unknown) => boolean;
    getStatus: () => PersistenceStatus;
    hasDirtyData: () => boolean;
    subscribe: (listener: (status: PersistenceStatus) => void) => () => void;
    dispose: () => void;
};

type PendingWrite = {
    id: string;
    revision: number;
    value: string | null;
};

type DurableSnapshot = {
    generation: number;
    value: string | null;
    writeId: string;
};

export type ExclusiveRunner = <T>(operation: () => Promise<T>) => Promise<T>;

type ReliableStateStorageOptions = {
    key: string;
    storage: StateStorage;
    debounceMs?: number;
    retryDelaysMs?: readonly number[];
    now?: () => Date;
    runExclusive?: ExclusiveRunner;
    createWriteId?: () => string;
};

const DURABLE_ENVELOPE_FORMAT = "infinite-canvas-state-v1";
const DURABLE_METADATA_KEY = "__infiniteCanvasPersistence";

export class PersistenceError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "PersistenceError";
    }
}

export class PersistenceConflictError extends PersistenceError {
    constructor(message: string) {
        super(message);
        this.name = "PersistenceConflictError";
    }
}

export class PersistenceUnavailableError extends PersistenceError {
    constructor(message: string) {
        super(message);
        this.name = "PersistenceUnavailableError";
    }
}

export class PersistenceHydrationRejectedError extends PersistenceError {
    constructor(message: string) {
        super(message);
        this.name = "PersistenceHydrationRejectedError";
    }
}

export class PersistenceHydrationAttemptError extends PersistenceError {
    readonly attempt: number;

    constructor(attempt: number, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "PersistenceHydrationAttemptError";
        this.attempt = attempt;
    }
}

export function createReliableStateStorage({
    key,
    storage,
    debounceMs = 250,
    retryDelaysMs = [1_000, 3_000, 10_000, 30_000],
    now = () => new Date(),
    runExclusive = createBrowserExclusiveRunner(key),
    createWriteId = defaultWriteId,
}: ReliableStateStorageOptions): ReliableStateStorage {
    let status: PersistenceStatus = {
        phase: "hydrating",
        ready: false,
        dirty: false,
        conflict: false,
        error: "",
        requestedRevision: 0,
        durableRevision: 0,
        lastSavedAt: "",
    };
    let pending: PendingWrite | null = null;
    let activeWrite: Promise<void> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let lastDurableValue: string | null = null;
    let lastDurableGeneration = 0;
    let blockedBeforeHydration = false;
    let hydrationReadComplete = false;
    let deferredHydrationWrite: { value: string | null } | null = null;
    let hydrationAttemptSequence = 0;
    let activeHydrationAttempt: number | null = null;
    let completedHydrationAttempt: number | null = null;
    let disposed = false;
    const listeners = new Set<(value: PersistenceStatus) => void>();

    const emit = (patch: Partial<PersistenceStatus>) => {
        status = { ...status, ...patch };
        listeners.forEach((listener) => listener(status));
    };

    const clearDebounce = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
    };

    const clearRetry = () => {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
    };

    const scheduleWrite = (delayMs = debounceMs) => {
        if (disposed || !pending || activeWrite) return;
        clearDebounce();
        emit({ phase: delayMs > 0 ? "scheduled" : "writing", dirty: true });
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void persistOnce();
        }, delayMs);
    };

    const scheduleRetry = () => {
        if (disposed || !pending || retryTimer || !retryDelaysMs.length) {
            emit({ phase: "error", dirty: Boolean(pending) || blockedBeforeHydration });
            return;
        }
        const delayMs = retryDelaysMs[Math.min(retryAttempt, retryDelaysMs.length - 1)];
        retryAttempt += 1;
        emit({ phase: "retry-wait", dirty: true });
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void persistOnce();
        }, delayMs);
    };

    const readStoredSnapshotUnlocked = async () => decodeDurableSnapshot(await Promise.resolve(storage.getItem(key)));
    const readHydrationSnapshot = () => runExclusive(readStoredSnapshotUnlocked);

    const commit = async (write: PendingWrite, generation: number) => Promise.resolve(storage.setItem(key, encodeDurableSnapshot({ generation, value: write.value, writeId: write.id })));

    const persistOnce = async () => {
        if (activeWrite) return activeWrite;
        if (!pending || disposed) return;
        clearDebounce();
        clearRetry();
        const write = pending;
        pending = null;
        emit({ phase: "writing", dirty: true });

        activeWrite = (async () => {
            let committed = false;
            let committedGeneration = lastDurableGeneration;
            let failure: unknown;
            try {
                try {
                    await runExclusive(async () => {
                        let current: DurableSnapshot;
                        try {
                            current = await readStoredSnapshotUnlocked();
                        } catch (error) {
                            failure = error;
                            return;
                        }

                        if (current.writeId === write.id && current.value === write.value) {
                            committed = true;
                            committedGeneration = current.generation;
                            return;
                        }
                        if (current.generation !== lastDurableGeneration || current.value !== lastDurableValue) {
                            failure = new PersistenceConflictError("本地数据已在另一个标签页更新，已阻止旧内容覆盖新内容");
                            return;
                        }

                        const nextGeneration = current.generation + 1;
                        try {
                            await commit(write, nextGeneration);
                        } catch (error) {
                            failure = error;
                        }
                        try {
                            const verified = await readStoredSnapshotUnlocked();
                            committed = verified.generation === nextGeneration && verified.writeId === write.id && verified.value === write.value;
                            if (committed) committedGeneration = verified.generation;
                        } catch (error) {
                            failure ||= error;
                        }
                        if (!committed && !failure) failure = new PersistenceError("写入后的数据校验失败");
                    });
                } catch (error) {
                    failure ||= error;
                }

                if (committed) {
                    lastDurableValue = write.value;
                    lastDurableGeneration = committedGeneration;
                    retryAttempt = 0;
                    emit({
                        error: "",
                        conflict: false,
                        durableRevision: Math.max(status.durableRevision, write.revision),
                        lastSavedAt: now().toISOString(),
                    });
                } else {
                    const queuedWrite = pending as PendingWrite | null;
                    if (!queuedWrite || queuedWrite.revision < write.revision) pending = write;
                    emit({ conflict: failure instanceof PersistenceConflictError, error: errorMessage(failure, "本地数据写入失败") });
                }
            } finally {
                activeWrite = null;
                if (disposed) return;
                if (failure instanceof PersistenceConflictError || failure instanceof PersistenceUnavailableError) emit({ phase: "error", dirty: true });
                else if (!committed) scheduleRetry();
                else if (pending) scheduleWrite(0);
                else emit({ phase: "clean", dirty: false });
            }
        })();
        return activeWrite;
    };

    const queue = (value: string | null) => {
        if (disposed) return;
        if (!status.ready) {
            if (hydrationReadComplete) {
                deferredHydrationWrite = { value };
                emit({ phase: "hydrating", dirty: value !== lastDurableValue, error: "" });
                return;
            }
            blockedBeforeHydration = true;
            emit({ phase: "error", dirty: true, error: "本地数据尚未成功加载，已阻止覆盖原有内容" });
            return;
        }
        if (!pending && !activeWrite && value === lastDurableValue) return;
        if (pending?.value === value) return;
        clearRetry();
        const revision = status.requestedRevision + 1;
        pending = { id: createWriteId(), revision, value };
        emit({ requestedRevision: revision, dirty: true });
        if (status.conflict) {
            emit({ phase: "error" });
            return;
        }
        scheduleWrite();
    };

    const flush = async () => {
        if (!status.ready) throw new PersistenceError(status.error || "本地数据尚未成功加载");
        if (status.conflict) throw new PersistenceConflictError(status.error || "本地数据存在跨标签页冲突");
        const targetRevision = status.requestedRevision;
        clearDebounce();
        clearRetry();
        while (status.durableRevision < targetRevision) {
            if (activeWrite) await activeWrite;
            else if (pending) await persistOnce();
            else break;
            if (status.error && status.durableRevision < targetRevision) throw new PersistenceError(status.error);
        }
        if (status.durableRevision < targetRevision) throw new PersistenceError(status.error || "本地数据尚未完整保存");
    };

    return {
        getItem: async (name) => {
            assertKey(name, key);
            if (activeHydrationAttempt !== null) throw new PersistenceHydrationRejectedError("本地数据正在加载，请等待当前读取完成");
            if (status.ready && (status.dirty || pending || activeWrite || deferredHydrationWrite)) throw new PersistenceHydrationRejectedError("存在尚未保存的本地数据，已阻止重新加载覆盖当前内容");
            const attempt = ++hydrationAttemptSequence;
            activeHydrationAttempt = attempt;
            completedHydrationAttempt = null;
            hydrationReadComplete = false;
            deferredHydrationWrite = null;
            emit({ phase: "hydrating", ready: false, conflict: false, error: "" });
            try {
                const snapshot = await readHydrationSnapshot();
                lastDurableValue = snapshot.value;
                lastDurableGeneration = snapshot.generation;
                hydrationReadComplete = true;
                completedHydrationAttempt = attempt;
                return snapshot.value;
            } catch (error) {
                const failure = new PersistenceHydrationAttemptError(attempt, errorMessage(error, "无法读取本地数据"), { cause: error });
                if (activeHydrationAttempt === attempt) emit({ phase: "error", ready: false, dirty: false, conflict: false, error: failure.message });
                throw failure;
            }
        },
        setItem: (name, value) => {
            assertKey(name, key);
            queue(value);
        },
        removeItem: async (name) => {
            assertKey(name, key);
            queue(null);
            await flush();
        },
        flush,
        retryNow: async () => {
            if (status.conflict) throw new PersistenceConflictError(status.error || "本地数据存在跨标签页冲突");
            retryAttempt = 0;
            clearRetry();
            await flush();
        },
        markHydrated: () => {
            if (activeHydrationAttempt === null || completedHydrationAttempt !== activeHydrationAttempt || !hydrationReadComplete) return false;
            const deferred = deferredHydrationWrite;
            blockedBeforeHydration = false;
            activeHydrationAttempt = null;
            completedHydrationAttempt = null;
            hydrationReadComplete = false;
            deferredHydrationWrite = null;
            clearDebounce();
            clearRetry();
            emit({ phase: "clean", ready: true, dirty: false, conflict: false, error: "" });
            if (deferred) queue(deferred.value);
            return true;
        },
        markHydrationError: (error) => {
            if (error instanceof PersistenceHydrationRejectedError) return false;
            if (error instanceof PersistenceHydrationAttemptError && error.attempt !== activeHydrationAttempt) return false;
            if (activeHydrationAttempt === null && status.phase !== "hydrating") return false;
            activeHydrationAttempt = null;
            completedHydrationAttempt = null;
            blockedBeforeHydration = false;
            hydrationReadComplete = false;
            deferredHydrationWrite = null;
            clearDebounce();
            clearRetry();
            emit({ phase: "error", ready: false, dirty: false, conflict: false, error: errorMessage(error, "无法加载本地数据") });
            return true;
        },
        getStatus: () => status,
        hasDirtyData: () => status.dirty || Boolean(pending) || Boolean(activeWrite) || Boolean(deferredHydrationWrite),
        subscribe: (listener) => {
            listeners.add(listener);
            listener(status);
            return () => listeners.delete(listener);
        },
        dispose: () => {
            disposed = true;
            clearDebounce();
            clearRetry();
            listeners.clear();
        },
    };
}

export function createBrowserExclusiveRunner(key: string, environment = { isBrowser: typeof window !== "undefined", locks: typeof navigator === "undefined" ? undefined : navigator.locks }): ExclusiveRunner {
    const { isBrowser, locks } = environment;
    if (!locks) {
        if (!isBrowser) return (operation) => operation();
        return async () => {
            throw new PersistenceUnavailableError("当前浏览器不支持安全的本地存储锁，已阻止可能覆盖数据的写入");
        };
    }
    return (operation) =>
        new Promise((resolve, reject) => {
            const lockName = `infinite-canvas-state:${key}`;
            void locks.request(getActiveLocalUserProfile() ? userScopedResourceName(lockName) : lockName, { mode: "exclusive" }, () => operation().then(resolve, reject)).catch(reject);
        });
}

function encodeDurableSnapshot(snapshot: DurableSnapshot) {
    const metadata = { format: DURABLE_ENVELOPE_FORMAT, generation: snapshot.generation, value: snapshot.value, writeId: snapshot.writeId };
    if (snapshot.value !== null) {
        try {
            const payload = JSON.parse(snapshot.value) as unknown;
            if (payload && typeof payload === "object" && !Array.isArray(payload) && !(DURABLE_METADATA_KEY in payload)) return JSON.stringify({ ...payload, [DURABLE_METADATA_KEY]: metadata });
        } catch {
            // Non-JSON state uses the generic envelope below.
        }
    }
    return JSON.stringify(metadata);
}

function decodeDurableSnapshot(raw: string | null): DurableSnapshot {
    if (raw === null) return { generation: 0, value: null, writeId: "" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { generation: 0, value: raw, writeId: "" };
    }
    if (!parsed || typeof parsed !== "object") return { generation: 0, value: raw, writeId: "" };
    const record = parsed as Record<string, unknown>;
    const metadata = record[DURABLE_METADATA_KEY];
    const envelope =
        metadata && typeof metadata === "object" && (metadata as { format?: unknown }).format === DURABLE_ENVELOPE_FORMAT
            ? (metadata as { generation?: unknown; value?: unknown; writeId?: unknown })
            : record.format === DURABLE_ENVELOPE_FORMAT
              ? (record as { generation?: unknown; value?: unknown; writeId?: unknown })
              : null;
    if (!envelope) return { generation: 0, value: raw, writeId: "" };
    if (!Number.isSafeInteger(envelope.generation) || (envelope.generation as number) < 1 || (envelope.value !== null && typeof envelope.value !== "string") || typeof envelope.writeId !== "string" || !envelope.writeId) {
        throw new PersistenceError("本地数据提交元数据损坏");
    }
    return { generation: envelope.generation as number, value: envelope.value as string | null, writeId: envelope.writeId };
}

export function decodeDurableStateValue(raw: string | null) {
    return decodeDurableSnapshot(raw).value;
}

function defaultWriteId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function assertKey(actual: string, expected: string) {
    if (actual !== expected) throw new PersistenceError(`Unexpected persistence key: ${actual}`);
}

function errorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}
