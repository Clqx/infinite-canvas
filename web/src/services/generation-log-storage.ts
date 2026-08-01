import localforage from "localforage";

import { createBrowserExclusiveRunner, type ExclusiveRunner } from "@/services/reliable-state-storage";

export type GenerationLogDomain = "image" | "video";
export type GenerationLogStore = Pick<LocalForage, "iterate">;
export type WritableGenerationLogStore = Pick<LocalForage, "getItem" | "iterate" | "removeItem" | "setItem">;
type GenerationLogStores = Readonly<Record<GenerationLogDomain, GenerationLogStore>>;

const defaultStores: Readonly<Record<GenerationLogDomain, WritableGenerationLogStore>> = {
    image: localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" }),
    video: localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" }),
};
const runGenerationLogsExclusive = createBrowserExclusiveRunner("generation-logs");

export async function setStoredGenerationLog(domain: GenerationLogDomain, id: string, value: unknown) {
    await runGenerationLogsExclusive(async () => void (await defaultStores[domain].setItem(id, value)));
}

export async function removeStoredGenerationLogs(domain: GenerationLogDomain, ids: Iterable<string>, store: WritableGenerationLogStore = defaultStores[domain], runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        const removedIds: string[] = [];
        for (const id of new Set(ids)) {
            const value = await store.getItem<unknown>(id);
            if (value === null) continue;
            if (domain === "video" && isActiveLog(value)) continue;
            await store.removeItem(id);
            removedIds.push(id);
        }
        return removedIds;
    });
}

export async function mergeStoredGenerationLogs(domain: GenerationLogDomain, incomingLogs: ReadonlyArray<Record<string, unknown>>, store: WritableGenerationLogStore = defaultStores[domain], runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        const currentLogs = (await readStoreValues(store)).filter(isLogRecord);
        const mergedLogs = mergeLogRecords(currentLogs, incomingLogs);
        for (const log of mergedLogs) {
            await store.setItem(log.id as string, log);
        }
        return mergedLogs;
    });
}

export async function readStoredGenerationLogs(domain: GenerationLogDomain) {
    return runGenerationLogsExclusive(() => readStoreValues(defaultStores[domain]));
}

export async function withAllStoredGenerationLogs<T>(operation: (logs: { imageLogs: unknown[]; videoLogs: unknown[] }) => Promise<T>, stores: GenerationLogStores = defaultStores, runExclusive: ExclusiveRunner = runGenerationLogsExclusive) {
    return runExclusive(async () => {
        const [imageLogs, videoLogs] = await Promise.all([readStoreValues(stores.image), readStoreValues(stores.video)]);
        return operation({ imageLogs, videoLogs });
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

function isLogRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string" && (value as Record<string, unknown>).id);
}

function isActiveLog(value: unknown) {
    return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).status === "生成中");
}

function logTime(log: Record<string, unknown>) {
    if (typeof log.createdAt === "number") return log.createdAt;
    if (typeof log.createdAt === "string") return Date.parse(log.createdAt) || 0;
    return 0;
}

async function readStoreValues(store: Pick<LocalForage, "iterate">) {
    const values: unknown[] = [];
    await store.iterate<unknown, void>((value) => {
        values.push(value);
    });
    return values;
}
