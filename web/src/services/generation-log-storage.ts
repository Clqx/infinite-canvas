import localforage from "localforage";
import { nanoid } from "nanoid";

import { createBrowserExclusiveRunner, type ExclusiveRunner } from "@/services/reliable-state-storage";
import { compareTombstones, type SyncTombstone } from "@/services/app-data-schema";

export type GenerationLogDomain = "image" | "video";
export type GenerationLogStore = Pick<LocalForage, "iterate">;
export type WritableGenerationLogStore = Pick<LocalForage, "getItem" | "iterate" | "removeItem" | "setItem">;
type GenerationLogStores = Readonly<Record<GenerationLogDomain, GenerationLogStore>>;
export type GenerationLogSnapshot = { logs: Record<string, unknown>[]; tombstones: SyncTombstone[] };

const TOMBSTONE_FORMAT = "infinite-canvas-generation-log-tombstone-v1";

const defaultStores: Readonly<Record<GenerationLogDomain, WritableGenerationLogStore>> = {
    image: localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" }),
    video: localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" }),
};
const runGenerationLogsExclusive = createBrowserExclusiveRunner("generation-logs");

export async function setStoredGenerationLog(domain: GenerationLogDomain, id: string, value: unknown) {
    await runGenerationLogsExclusive(async () => {
        const existing = await defaultStores[domain].getItem<unknown>(id);
        if (isStoredTombstone(existing)) return;
        const storedValue = isLogRecord(value) ? { ...value, updatedAt: new Date().toISOString() } : value;
        await defaultStores[domain].setItem(id, storedValue);
    });
}

export async function removeStoredGenerationLogs(domain: GenerationLogDomain, ids: Iterable<string>, store: WritableGenerationLogStore = defaultStores[domain], runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        const removedIds: string[] = [];
        for (const id of new Set(ids)) {
            const value = await store.getItem<unknown>(id);
            if (value === null) continue;
            if (domain === "video" && isActiveLog(value)) continue;
            const tombstone = { format: TOMBSTONE_FORMAT, id, deletedAt: new Date().toISOString(), eventId: nanoid() };
            await store.setItem(id, tombstone);
            removedIds.push(id);
        }
        return removedIds;
    });
}

export async function purgeStoredGenerationLogs(domain: GenerationLogDomain, ids: Iterable<string>, store: WritableGenerationLogStore = defaultStores[domain], runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        for (const id of new Set(ids)) await store.removeItem(id);
    });
}

export async function mergeStoredGenerationLogs(domain: GenerationLogDomain, incomingLogs: ReadonlyArray<Record<string, unknown>>, store: WritableGenerationLogStore = defaultStores[domain], runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return (await mergeStoredGenerationSnapshot(domain, { logs: [...incomingLogs], tombstones: [] }, store, runExclusive)).logs;
}

export async function mergeStoredGenerationSnapshot(domain: GenerationLogDomain, incoming: GenerationLogSnapshot, store: WritableGenerationLogStore = defaultStores[domain], runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        const values = await readStoreValues(store, true);
        const current = splitStoredValues(values);
        const tombstones = mergeTombstones(current.tombstones, incoming.tombstones);
        const mergedLogs = mergeLogRecords(current.logs, incoming.logs).filter((log) => {
            const tombstone = tombstones.find((item) => item.id === log.id);
            return !tombstone || logTime(log) > Date.parse(tombstone.deletedAt);
        });
        const liveIds = new Set(mergedLogs.map((log) => log.id as string));
        for (const log of mergedLogs) {
            await store.setItem(log.id as string, log);
        }
        for (const tombstone of tombstones) {
            if (liveIds.has(tombstone.id)) continue;
            await store.setItem(tombstone.id, { format: TOMBSTONE_FORMAT, ...tombstone });
        }
        return { logs: mergedLogs, tombstones };
    });
}

export async function readStoredGenerationLogs(domain: GenerationLogDomain) {
    return runGenerationLogsExclusive(() => readStoreValues(defaultStores[domain]));
}

export async function readStoredGenerationSnapshot(domain: GenerationLogDomain): Promise<GenerationLogSnapshot> {
    return runGenerationLogsExclusive(async () => splitStoredValues(await readStoreValues(defaultStores[domain], true)));
}

export async function withAllStoredGenerationLogs<T>(operation: (logs: { imageLogs: unknown[]; videoLogs: unknown[] }) => Promise<T>, stores: GenerationLogStores = defaultStores, runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        const [imageLogs, videoLogs] = await Promise.all([readStoreValues(stores.image), readStoreValues(stores.video)]);
        return operation({ imageLogs, videoLogs });
    });
}

export async function withAllStoredGenerationSnapshots<T>(
    operation: (snapshots: { image: GenerationLogSnapshot; video: GenerationLogSnapshot }) => Promise<T>,
    stores: GenerationLogStores = defaultStores,
    runExclusive: ExclusiveRunner = runGenerationLogsExclusive,
) {
    return runExclusive(async () => {
        const [imageValues, videoValues] = await Promise.all([readStoreValues(stores.image, true), readStoreValues(stores.video, true)]);
        return operation({ image: splitStoredValues(imageValues), video: splitStoredValues(videoValues) });
    });
}

export async function readAllStoredGenerationLogs(stores: GenerationLogStores = defaultStores, runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return withAllStoredGenerationLogs(async (logs) => logs, stores, runExclusive);
}

export function filterDeletableGenerationLogIds(logs: ReadonlyArray<{ id: string; status?: string }>, selectedIds: Iterable<string>) {
    const selected = new Set(selectedIds);
    return logs.filter((log) => log.status !== "生成中" && selected.has(log.id)).map((log) => log.id);
}

function mergeLogRecords(currentLogs: Record<string, unknown>[], incomingLogs: ReadonlyArray<Record<string, unknown>>) {
    const merged = new Map<string, Record<string, unknown>>();
    for (const log of incomingLogs) {
        if (typeof log.id === "string" && log.id) merged.set(log.id, log);
    }
    for (const log of currentLogs) {
        const id = log.id as string;
        const existing = merged.get(id);
        if (!existing || logTime(log) >= logTime(existing)) merged.set(id, log);
    }
    return Array.from(merged.values()).sort((a, b) => logTime(b) - logTime(a));
}

function mergeTombstones(current: SyncTombstone[], incoming: SyncTombstone[]) {
    const merged = new Map<string, SyncTombstone>();
    for (const tombstone of [...current, ...incoming]) {
        const existing = merged.get(tombstone.id);
        if (!existing || compareTombstones(tombstone, existing) > 0) merged.set(tombstone.id, tombstone);
    }
    return Array.from(merged.values());
}

function isLogRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !isStoredTombstone(value) && typeof (value as Record<string, unknown>).id === "string" && (value as Record<string, unknown>).id);
}

function isStoredTombstone(value: unknown): value is SyncTombstone & { format: typeof TOMBSTONE_FORMAT } {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.format === TOMBSTONE_FORMAT && typeof record.id === "string" && Boolean(record.id) && typeof record.deletedAt === "string" && Number.isFinite(Date.parse(record.deletedAt)) && typeof record.eventId === "string" && Boolean(record.eventId);
}

function isActiveLog(value: unknown) {
    return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).status === "生成中");
}

function logTime(log: Record<string, unknown>) {
    if (typeof log.updatedAt === "number") return log.updatedAt;
    if (typeof log.updatedAt === "string") return Date.parse(log.updatedAt) || 0;
    if (typeof log.createdAt === "number") return log.createdAt;
    if (typeof log.createdAt === "string") return Date.parse(log.createdAt) || 0;
    return 0;
}

function splitStoredValues(values: unknown[]): GenerationLogSnapshot {
    const invalid = values.find((value) => !isLogRecord(value) && !isStoredTombstone(value));
    if (invalid !== undefined) throw new Error("生成记录存储包含无法识别的数据");
    return {
        logs: values.filter(isLogRecord),
        tombstones: values.filter(isStoredTombstone).map(({ id, deletedAt, eventId }) => ({ id, deletedAt, eventId })),
    };
}

async function readStoreValues(store: Pick<LocalForage, "iterate">, includeTombstones = false) {
    const values: unknown[] = [];
    await store.iterate<unknown, void>((value) => {
        if (includeTombstones || !isStoredTombstone(value)) values.push(value);
    });
    return values;
}
