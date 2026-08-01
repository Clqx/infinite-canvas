import { localForageStorage } from "@/lib/localforage-storage";
import { createBrowserExclusiveRunner, createReliableStateStorage, decodeDurableStateValue, PersistenceError, type ExclusiveRunner, type PersistencePhase, type PersistenceStatus, type ReliableStateStorage } from "@/services/reliable-state-storage";

export const CANVAS_STATE_STORAGE_KEY = "infinite-canvas:canvas_store";
export const ASSET_STATE_STORAGE_KEY = "infinite-canvas:asset_store";

export type AppDataPersistenceChannel = "canvas" | "assets";
export type AppDataPersistenceChannels = Readonly<Record<AppDataPersistenceChannel, ReliableStateStorage>>;

export type AppDataPersistenceStatus = Readonly<{
    phase: PersistencePhase;
    ready: boolean;
    dirty: boolean;
    hasError: boolean;
    hasConflict: boolean;
    error: string;
    errors: Readonly<Partial<Record<AppDataPersistenceChannel, string>>>;
    channels: Readonly<Record<AppDataPersistenceChannel, PersistenceStatus>>;
}>;

export type AppDataPersistenceCoordinator = {
    channels: AppDataPersistenceChannels;
    getStatus: () => AppDataPersistenceStatus;
    subscribe: (listener: (status: AppDataPersistenceStatus) => void) => () => void;
    registerCheckpoint: (checkpoint: () => void) => () => void;
    runCheckpoints: () => void;
    flushAll: () => Promise<void>;
    retryAll: () => Promise<void>;
    hasDirtyData: () => boolean;
    hasErrors: () => boolean;
    dispose: () => void;
};

export type AuthoritativeAppData = Readonly<{ projects: unknown[]; assets: unknown[] }>;
export type AuthoritativeAppDataReader = <T>(operation: (data: AuthoritativeAppData) => Promise<T>) => Promise<T>;

export function createAppDataPersistenceCoordinator(channels: AppDataPersistenceChannels): AppDataPersistenceCoordinator {
    let disposed = false;
    let status = aggregateStatus(channels);
    const listeners = new Set<(value: AppDataPersistenceStatus) => void>();
    const checkpoints = new Set<() => void>();

    const refreshStatus = () => {
        const next = aggregateStatus(channels);
        if (sameStatus(status, next)) return;
        status = next;
        listeners.forEach((listener) => listener(status));
    };
    const channelUnsubscribers = [channels.canvas.subscribe(refreshStatus), channels.assets.subscribe(refreshStatus)];

    const runCheckpoints = () => {
        if (disposed) return;
        [...checkpoints].forEach((checkpoint) => checkpoint());
    };

    return {
        channels,
        getStatus: () => status,
        subscribe: (listener) => {
            listener(status);
            if (disposed) return () => undefined;
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        registerCheckpoint: (checkpoint) => {
            if (disposed) return () => undefined;
            checkpoints.add(checkpoint);
            return () => checkpoints.delete(checkpoint);
        },
        runCheckpoints,
        flushAll: async () => {
            runCheckpoints();
            await Promise.all([channels.canvas.flush(), channels.assets.flush()]);
        },
        retryAll: async () => {
            runCheckpoints();
            await Promise.all([channels.canvas.retryNow(), channels.assets.retryNow()]);
        },
        hasDirtyData: () => channels.canvas.hasDirtyData() || channels.assets.hasDirtyData(),
        hasErrors: () => Boolean(channels.canvas.getStatus().error || channels.assets.getStatus().error),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            channelUnsubscribers.forEach((unsubscribe) => unsubscribe());
            listeners.clear();
            checkpoints.clear();
            channels.canvas.dispose();
            channels.assets.dispose();
        },
    };
}

function aggregateStatus(channels: AppDataPersistenceChannels): AppDataPersistenceStatus {
    const channelStatuses = {
        canvas: channels.canvas.getStatus(),
        assets: channels.assets.getStatus(),
    };
    const errors: Partial<Record<AppDataPersistenceChannel, string>> = {};
    if (channelStatuses.canvas.error) errors.canvas = channelStatuses.canvas.error;
    if (channelStatuses.assets.error) errors.assets = channelStatuses.assets.error;
    const hasError = Boolean(errors.canvas || errors.assets);
    const hasConflict = channelStatuses.canvas.conflict || channelStatuses.assets.conflict;

    return Object.freeze({
        phase: aggregatePhase(channelStatuses, hasError),
        ready: channelStatuses.canvas.ready && channelStatuses.assets.ready,
        dirty: channels.canvas.hasDirtyData() || channels.assets.hasDirtyData(),
        hasError,
        hasConflict,
        error: [errors.canvas ? `画布：${errors.canvas}` : "", errors.assets ? `资产：${errors.assets}` : ""].filter(Boolean).join("；"),
        errors: Object.freeze(errors),
        channels: Object.freeze(channelStatuses),
    });
}

function aggregatePhase(statuses: Record<AppDataPersistenceChannel, PersistenceStatus>, hasError: boolean): PersistencePhase {
    if (hasError) return "error";
    const phases = [statuses.canvas.phase, statuses.assets.phase];
    if (phases.includes("writing")) return "writing";
    if (phases.includes("retry-wait")) return "retry-wait";
    if (phases.includes("scheduled")) return "scheduled";
    if (phases.includes("hydrating")) return "hydrating";
    return "clean";
}

function sameStatus(previous: AppDataPersistenceStatus, next: AppDataPersistenceStatus) {
    return (
        previous.phase === next.phase &&
        previous.ready === next.ready &&
        previous.dirty === next.dirty &&
        previous.hasError === next.hasError &&
        previous.hasConflict === next.hasConflict &&
        previous.error === next.error &&
        previous.channels.canvas === next.channels.canvas &&
        previous.channels.assets === next.channels.assets
    );
}

const runAppDataExclusive = createBrowserExclusiveRunner("app-data");

export function createAuthoritativeAppDataReader({ storage, runExclusive }: { storage: { getItem: (key: string) => Promise<string | null> | string | null }; runExclusive: ExclusiveRunner }): AuthoritativeAppDataReader {
    return (operation) =>
        runExclusive(async () => {
            const [canvasRaw, assetRaw] = await Promise.all([storage.getItem(CANVAS_STATE_STORAGE_KEY), storage.getItem(ASSET_STATE_STORAGE_KEY)]);
            return operation({
                projects: readPersistedCollection(canvasRaw, "projects"),
                assets: readPersistedCollection(assetRaw, "assets"),
            });
        });
}

function readPersistedCollection(raw: string | null, field: "projects" | "assets") {
    const value = decodeDurableStateValue(raw);
    if (value === null) return [];
    try {
        const parsed = JSON.parse(value) as { state?: Record<string, unknown> };
        const collection = parsed?.state?.[field];
        if (!Array.isArray(collection)) throw new Error(`Missing ${field}`);
        return collection;
    } catch (error) {
        throw new PersistenceError("本地数据引用快照无法读取，已停止媒体清理", { cause: error });
    }
}

export const withAuthoritativeAppData = createAuthoritativeAppDataReader({ storage: localForageStorage, runExclusive: runAppDataExclusive });
export const canvasStateStorage = createReliableStateStorage({ key: CANVAS_STATE_STORAGE_KEY, storage: localForageStorage, runExclusive: runAppDataExclusive });
export const assetStateStorage = createReliableStateStorage({ key: ASSET_STATE_STORAGE_KEY, storage: localForageStorage, runExclusive: runAppDataExclusive });

export const appDataPersistence = createAppDataPersistenceCoordinator({
    canvas: canvasStateStorage,
    assets: assetStateStorage,
});
