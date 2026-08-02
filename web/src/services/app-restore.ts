import { nanoid } from "nanoid";

import { flushAppDataPersistence } from "@/services/app-data-persistence-actions";
import { migrateAssetData, migrateCanvasData } from "@/services/app-data-schema";
import { MAX_APP_BACKUP_MEDIA_BYTES, readVerifiedAppBackup, type AppBackupManifest } from "@/services/app-backup";
import { sha256Blob } from "@/services/content-digest";
import { deleteStoredMedia, getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { mergeStoredGenerationSnapshot, purgeStoredGenerationLogs, readStoredGenerationSnapshot } from "@/services/generation-log-storage";
import { deleteStoredImages, getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { createBrowserExclusiveRunner } from "@/services/reliable-state-storage";
import { createUserScopedLocalForage, userScopedResourceName } from "@/services/local-user-profiles";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const RESTORE_JOURNAL_KEY = "active";
const RESTORE_COMPLETION_KEY = "last_completion";
const RESTORE_JOURNAL_FORMAT = "infinite-canvas-copy-restore-v1";
const RESTORE_CHANNEL_NAME = "infinite-canvas:app-restore";
const restoreStore = createUserScopedLocalForage({ name: "infinite-canvas", storeName: "app_restore_journal" });
const runRestoreExclusive = createBrowserExclusiveRunner("app-restore");
const runMaintenanceExclusive = createBrowserExclusiveRunner("app-maintenance");
const restoreSourceId = nanoid();
const restoreListeners = new Set<(remote: boolean) => void>();
let restoreChannel: BroadcastChannel | null = null;

type RestorePhase = "staging" | "committing";
type RestoreStep = "canvas" | "assets" | "imageLogs" | "videoLogs";

export type RestoreMediaPlan = {
    sourceKey: string;
    targetKey: string;
    path: string;
    mimeType: string;
    bytes: number;
    sha256: string;
};

export type AppRestoreJournal = {
    format: typeof RESTORE_JOURNAL_FORMAT;
    id: string;
    phase: RestorePhase;
    createdAt: string;
    sourceExportedAt: string;
    media: RestoreMediaPlan[];
    stagedKeys: string[];
    data: {
        projects: CanvasProject[];
        assets: Asset[];
        imageLogs: Record<string, unknown>[];
        videoLogs: Record<string, unknown>[];
    };
    completed: Record<RestoreStep, boolean>;
};

export type AppRestoreSummary = {
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
    bytes: number;
};

export async function importAppBackupAsCopies(file: Blob): Promise<AppRestoreSummary> {
    const observedCompletion = await readCompletionToken();
    return runMaintenanceExclusive(() =>
        runRestoreExclusive(async () => {
            if ((await readCompletionToken()) !== observedCompletion) throw new Error("另一个标签页已完成恢复操作，请刷新后确认内容");
            if (await readJournal()) throw new Error("已有未完成的恢复任务，请先继续或回退");
            notifyRestoreChanged();
            await waitForAppDataHydration();
            const verified = await readVerifiedAppBackup(file);
            const journal = await prepareAppRestoreJournal(verified.manifest);
            await writeJournal(journal);
            try {
                for (const media of journal.media) {
                    const source = verified.entries.get(media.path);
                    if (!source) throw new Error(`恢复文件缺失: ${media.path}`);
                    const blob = source.slice(0, source.size, media.mimeType);
                    await (media.targetKey.startsWith("image:") ? setImageBlob(media.targetKey, blob) : setMediaBlob(media.targetKey, blob));
                    await verifyRestoreMediaBlob(media, media.targetKey.startsWith("image:") ? await getImageBlob(media.targetKey) : await getMediaBlob(media.targetKey));
                    journal.stagedKeys.push(media.targetKey);
                    await writeJournal(journal);
                }
                journal.phase = "committing";
                await writeJournal(journal);
                await commitJournal(journal);
                return summarizeJournal(journal);
            } catch (error) {
                const current = await readJournal();
                if (current?.phase === "staging") await rollbackJournal(current);
                else if (current) throw new Error(`${error instanceof Error ? error.message : "恢复提交失败"}；已保留恢复任务，可刷新后继续或回退`);
                throw error;
            }
        }),
    );
}

export async function getPendingAppRestore() {
    return runRestoreExclusive(() => readJournal());
}

export function subscribeAppRestore(listener: (remote: boolean) => void) {
    restoreListeners.add(listener);
    ensureRestoreChannel();
    return () => void restoreListeners.delete(listener);
}

export async function readPendingAppRestoreMediaKeys() {
    const journal = await readJournal();
    return journal ? collectAppRestoreMediaKeys(journal) : [];
}

export async function resumeAppRestore() {
    return runMaintenanceExclusive(() =>
        runRestoreExclusive(async () => {
            await waitForAppDataHydration();
            const journal = await readJournal();
            if (!journal) return null;
            if (journal.phase !== "committing") throw new Error("恢复暂存未完成，只能回退后重新导入备份");
            notifyRestoreChanged();
            await commitJournal(journal);
            return summarizeJournal(journal);
        }),
    );
}

export async function rollbackAppRestore() {
    return runMaintenanceExclusive(() =>
        runRestoreExclusive(async () => {
            await waitForAppDataHydration();
            const journal = await readJournal();
            if (!journal) return;
            notifyRestoreChanged();
            await rollbackJournal(journal);
        }),
    );
}

export async function discardInvalidAppRestoreJournal() {
    return runMaintenanceExclusive(() =>
        runRestoreExclusive(async () => {
            const value = await restoreStore.getItem<unknown>(RESTORE_JOURNAL_KEY);
            if (value === null) return;
            try {
                parseAppRestoreJournal(value);
            } catch {
                await clearJournal(nanoid());
                return;
            }
            throw new Error("恢复日志仍然有效，请继续或回退当前任务");
        }),
    );
}

export async function prepareAppRestoreJournal(
    manifest: AppBackupManifest,
    options: {
        idFactory?: () => string;
        now?: string;
        storageKeyExists?: (key: string) => Promise<boolean>;
        reservedIds?: Iterable<string>;
    } = {},
): Promise<AppRestoreJournal> {
    const idFactory = options.idFactory || nanoid;
    const now = options.now || new Date().toISOString();
    const usedIds = new Set(options.reservedIds || (await collectCurrentIds()));
    const storageKeyExists = options.storageKeyExists || defaultStorageKeyExists;
    const mediaKeyMap = new Map<string, string>();
    const usedMediaKeys = new Set<string>();
    const media: RestoreMediaPlan[] = [];
    for (const file of manifest.files) {
        const prefix = file.storageKey.slice(0, file.storageKey.indexOf(":"));
        let targetKey = "";
        do targetKey = `${prefix}:${idFactory()}`;
        while (usedMediaKeys.has(targetKey) || (await storageKeyExists(targetKey)));
        usedMediaKeys.add(targetKey);
        mediaKeyMap.set(file.storageKey, targetKey);
        media.push({ sourceKey: file.storageKey, targetKey, path: file.path, mimeType: file.mimeType, bytes: file.bytes, sha256: file.sha256 });
    }
    const rewrite = <T>(value: T) => rewriteMediaKeys(value, mediaKeyMap) as T;
    const projects = manifest.data.canvas.projects.map((project) => ({ ...rewrite(project), id: nextUniqueId(idFactory, usedIds), title: `${project.title}（恢复副本）`, createdAt: now, updatedAt: now }));
    const assets = manifest.data.assets.assets.map((asset) => ({ ...rewrite(asset), id: nextUniqueId(idFactory, usedIds), title: `${asset.title}（恢复副本）`, createdAt: now, updatedAt: now }) as Asset);
    const imageLogs = manifest.data.imageWorkbench.logs.map((log) => ({ ...rewrite(log), id: nextUniqueId(idFactory, usedIds), createdAt: now, updatedAt: now }));
    const videoLogs = manifest.data.videoWorkbench.logs.map((log) => {
        const rewritten: Record<string, unknown> = { ...rewrite(log), id: nextUniqueId(idFactory, usedIds), createdAt: now, updatedAt: now };
        if (rewritten.status !== "生成中") return rewritten;
        const { task: _task, ...interrupted } = rewritten;
        return { ...interrupted, status: "失败", error: "该任务来自备份副本，请重新生成" };
    });
    return {
        format: RESTORE_JOURNAL_FORMAT,
        id: nextUniqueId(idFactory, usedIds),
        phase: "staging",
        createdAt: now,
        sourceExportedAt: manifest.exportedAt,
        media,
        stagedKeys: [],
        data: { projects, assets, imageLogs, videoLogs },
        completed: { canvas: false, assets: false, imageLogs: false, videoLogs: false },
    };
}

export async function commitRestoreSteps(journal: AppRestoreJournal, operations: Record<RestoreStep, () => Promise<void>> & { verify: () => Promise<void> }, persist: (journal: AppRestoreJournal) => Promise<void>) {
    const steps: RestoreStep[] = ["canvas", "assets", "imageLogs", "videoLogs"];
    for (const step of steps) {
        if (journal.completed[step]) continue;
        await operations[step]();
        journal.completed[step] = true;
        await persist(journal);
    }
    await operations.verify();
}

async function commitJournal(journal: AppRestoreJournal) {
    await commitRestoreSteps(
        journal,
        {
            canvas: async () => {
                const state = useCanvasStore.getState();
                const existing = new Set(state.projects.map((item) => item.id));
                const additions = journal.data.projects.filter((item) => !existing.has(item.id));
                useCanvasStore.getState().replaceProjects(
                    [...additions, ...state.projects],
                    state.projectTombstones.filter((item) => !additions.some((project) => project.id === item.id)),
                );
                await flushAppDataPersistence();
            },
            assets: async () => {
                const state = useAssetStore.getState();
                const existing = new Set(state.assets.map((item) => item.id));
                const additions = await Promise.all(journal.data.assets.filter((item) => !existing.has(item.id)).map(hydrateAsset));
                useAssetStore.getState().replaceAssets(
                    [...additions, ...state.assets],
                    state.assetTombstones.filter((item) => !additions.some((asset) => asset.id === item.id)),
                );
                await flushAppDataPersistence();
            },
            imageLogs: () => mergeStoredGenerationSnapshot("image", { logs: journal.data.imageLogs, tombstones: [] }).then(() => undefined),
            videoLogs: () => mergeStoredGenerationSnapshot("video", { logs: journal.data.videoLogs, tombstones: [] }).then(() => undefined),
            verify: () => verifyCommittedJournal(journal),
        },
        writeJournal,
    );
    await clearJournal(nanoid());
}

async function rollbackJournal(journal: AppRestoreJournal) {
    const projectIds = new Set(journal.data.projects.map((item) => item.id));
    const assetIds = new Set(journal.data.assets.map((item) => item.id));
    const canvas = useCanvasStore.getState();
    const assets = useAssetStore.getState();
    useCanvasStore.getState().replaceProjects(
        canvas.projects.filter((item) => !projectIds.has(item.id)),
        canvas.projectTombstones.filter((item) => !projectIds.has(item.id)),
    );
    useAssetStore.getState().replaceAssets(
        assets.assets.filter((item) => !assetIds.has(item.id)),
        assets.assetTombstones.filter((item) => !assetIds.has(item.id)),
    );
    await flushAppDataPersistence();
    await purgeStoredGenerationLogs(
        "image",
        journal.data.imageLogs.map((item) => item.id as string),
    );
    await purgeStoredGenerationLogs(
        "video",
        journal.data.videoLogs.map((item) => item.id as string),
    );
    await deleteRestoreMedia(journal);
    await clearJournal(nanoid());
}

async function deleteRestoreMedia(journal: AppRestoreJournal) {
    const imageKeys: string[] = [];
    const mediaKeys: string[] = [];
    for (const item of journal.media) {
        const blob = item.targetKey.startsWith("image:") ? await getImageBlob(item.targetKey) : await getMediaBlob(item.targetKey);
        if (!blob) continue;
        await verifyRestoreMediaBlob(item, blob);
        (item.targetKey.startsWith("image:") ? imageKeys : mediaKeys).push(item.targetKey);
    }
    await Promise.all([deleteStoredImages(imageKeys), deleteStoredMedia(mediaKeys)]);
}

async function verifyCommittedJournal(journal: AppRestoreJournal) {
    const projectIds = new Set(useCanvasStore.getState().projects.map((item) => item.id));
    const assetIds = new Set(useAssetStore.getState().assets.map((item) => item.id));
    const [image, video] = await Promise.all([readStoredGenerationSnapshot("image"), readStoredGenerationSnapshot("video")]);
    const imageIds = new Set(image.logs.map((item) => item.id));
    const videoIds = new Set(video.logs.map((item) => item.id));
    if (
        journal.data.projects.some((item) => !projectIds.has(item.id)) ||
        journal.data.assets.some((item) => !assetIds.has(item.id)) ||
        journal.data.imageLogs.some((item) => !imageIds.has(item.id)) ||
        journal.data.videoLogs.some((item) => !videoIds.has(item.id))
    ) {
        throw new Error("恢复提交校验失败，已保留恢复日志");
    }
    for (const item of journal.media) {
        const blob = item.targetKey.startsWith("image:") ? await getImageBlob(item.targetKey) : await getMediaBlob(item.targetKey);
        await verifyRestoreMediaBlob(item, blob);
    }
}

export function collectAppRestoreMediaKeys(journal: AppRestoreJournal) {
    return [...new Set(journal.media.map((item) => item.targetKey))];
}

export async function verifyRestoreMediaBlob(item: RestoreMediaPlan, blob: Blob | null) {
    if (!blob || blob.size !== item.bytes || (await sha256Blob(blob)) !== item.sha256) throw new Error(`恢复媒体校验失败: ${item.targetKey}`);
}

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } };
    }
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } };
    }
    return asset;
}

async function collectCurrentIds() {
    const [image, video] = await Promise.all([readStoredGenerationSnapshot("image"), readStoredGenerationSnapshot("video")]);
    return [
        ...useCanvasStore.getState().projects.map((item) => item.id),
        ...useCanvasStore.getState().projectTombstones.map((item) => item.id),
        ...useAssetStore.getState().assets.map((item) => item.id),
        ...useAssetStore.getState().assetTombstones.map((item) => item.id),
        ...image.logs.map((item) => item.id as string),
        ...image.tombstones.map((item) => item.id),
        ...video.logs.map((item) => item.id as string),
        ...video.tombstones.map((item) => item.id),
    ];
}

async function defaultStorageKeyExists(key: string) {
    return Boolean(key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key));
}

function nextUniqueId(factory: () => string, used: Set<string>) {
    let id = "";
    do id = factory();
    while (!id || used.has(id));
    used.add(id);
    return id;
}

function rewriteMediaKeys(value: unknown, mediaKeys: ReadonlyMap<string, string>): unknown {
    if (typeof value === "string") return mediaKeys.get(value) || value;
    if (Array.isArray(value)) return value.map((item) => rewriteMediaKeys(item, mediaKeys));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteMediaKeys(item, mediaKeys)]));
}

function summarizeJournal(journal: AppRestoreJournal): AppRestoreSummary {
    return {
        projects: journal.data.projects.length,
        assets: journal.data.assets.length,
        imageLogs: journal.data.imageLogs.length,
        videoLogs: journal.data.videoLogs.length,
        files: journal.media.length,
        bytes: Array.from(new Map(journal.media.map((item) => [item.path, item.bytes])).values()).reduce((sum, bytes) => sum + bytes, 0),
    };
}

async function waitForAppDataHydration() {
    if (useCanvasStore.getState().hydrated && useAssetStore.getState().hydrated) return;
    await Promise.all([waitForStore(useCanvasStore), waitForStore(useAssetStore)]);
}

function waitForStore<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

async function readJournal() {
    const value = await restoreStore.getItem<unknown>(RESTORE_JOURNAL_KEY);
    return value === null ? null : parseAppRestoreJournal(value);
}

async function readCompletionToken() {
    const value = await restoreStore.getItem<unknown>(RESTORE_COMPLETION_KEY);
    if (value !== null && (typeof value !== "string" || !value)) throw new Error("恢复完成标记无效");
    return value;
}

async function writeCompletionToken(value: string) {
    try {
        await restoreStore.setItem(RESTORE_COMPLETION_KEY, value);
    } catch (error) {
        if ((await restoreStore.getItem(RESTORE_COMPLETION_KEY)) !== value) throw error;
    }
    if ((await restoreStore.getItem(RESTORE_COMPLETION_KEY)) !== value) throw new Error("恢复完成标记写入校验失败");
}

async function writeJournal(journal: AppRestoreJournal) {
    const expected = JSON.stringify(journal);
    try {
        await restoreStore.setItem(RESTORE_JOURNAL_KEY, journal);
    } catch (error) {
        const committed = await restoreStore.getItem<unknown>(RESTORE_JOURNAL_KEY);
        if (JSON.stringify(committed) !== expected) throw error;
    }
    const committed = await restoreStore.getItem<unknown>(RESTORE_JOURNAL_KEY);
    if (JSON.stringify(committed) !== expected) throw new Error("恢复日志写入校验失败");
}

async function clearJournal(completionToken: string) {
    await writeCompletionToken(completionToken);
    await removeVerifiedRestoreJournal(
        () => restoreStore.removeItem(RESTORE_JOURNAL_KEY),
        () => restoreStore.getItem(RESTORE_JOURNAL_KEY),
    );
    notifyRestoreChanged();
}

export async function removeVerifiedRestoreJournal(remove: () => Promise<unknown>, read: () => Promise<unknown>) {
    let confirmed = false;
    try {
        await remove();
    } catch (error) {
        if ((await read()) !== null) throw error;
        confirmed = true;
    }
    if (!confirmed && (await read()) !== null) throw new Error("恢复日志清理失败");
}

export function parseAppRestoreJournal(value: unknown): AppRestoreJournal {
    const journal = strictRecord(value, "恢复日志");
    strictKeys(journal, ["format", "id", "phase", "createdAt", "sourceExportedAt", "media", "stagedKeys", "data", "completed"], "恢复日志");
    if (journal.format !== RESTORE_JOURNAL_FORMAT || (journal.phase !== "staging" && journal.phase !== "committing")) throw new Error("恢复日志格式无效");
    const id = restoreId(journal.id, "恢复日志标识");
    const createdAt = isoDate(journal.createdAt, "恢复日志创建时间");
    const sourceExportedAt = isoDate(journal.sourceExportedAt, "备份导出时间");
    const data = strictRecord(journal.data, "恢复日志数据");
    strictKeys(data, ["projects", "assets", "imageLogs", "videoLogs"], "恢复日志数据");
    const canvas = migrateCanvasData({ projects: data.projects, projectTombstones: [] }, 2);
    const assets = migrateAssetData({ assets: data.assets, assetTombstones: [] }, 2);
    const parseLogs = (logs: unknown) => {
        if (!Array.isArray(logs)) throw new Error("恢复日志生成记录无效");
        return logs.map((item) => {
            const record = strictRecord(item, "恢复日志生成记录");
            restoreId(record.id, "恢复日志生成记录标识");
            return record;
        });
    };
    const imageLogs = parseLogs(data.imageLogs);
    const videoLogs = parseLogs(data.videoLogs);
    const completed = strictRecord(journal.completed, "恢复日志进度");
    strictKeys(completed, ["canvas", "assets", "imageLogs", "videoLogs"], "恢复日志进度");
    const completedValues = [completed.canvas, completed.assets, completed.imageLogs, completed.videoLogs];
    if (completedValues.some((item) => typeof item !== "boolean") || completedValues.some((item, index) => item && completedValues.slice(0, index).some((previous) => !previous))) throw new Error("恢复日志进度无效");
    const sourceKeys = new Set<string>();
    const targetKeys = new Set<string>();
    const media = strictArray(journal.media, "恢复日志媒体").map((value) => {
        const item = strictRecord(value, "恢复日志媒体描述");
        strictKeys(item, ["sourceKey", "targetKey", "path", "mimeType", "bytes", "sha256"], "恢复日志媒体描述");
        const sourceKey = storageKey(item.sourceKey, false);
        const targetKey = storageKey(item.targetKey, true);
        const sha256 = typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) ? item.sha256 : "";
        const path = typeof item.path === "string" ? item.path : "";
        const mimeType = typeof item.mimeType === "string" ? item.mimeType : "";
        if (
            sourceKey.split(":", 1)[0] !== targetKey.split(":", 1)[0] ||
            sourceKeys.has(sourceKey) ||
            targetKeys.has(targetKey) ||
            !sha256 ||
            !path.startsWith(`files/${sha256}.`) ||
            !/^files\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(path) ||
            !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ||
            !Number.isSafeInteger(item.bytes) ||
            (item.bytes as number) <= 0 ||
            (item.bytes as number) > MAX_APP_BACKUP_MEDIA_BYTES
        )
            throw new Error("恢复日志媒体描述无效");
        sourceKeys.add(sourceKey);
        targetKeys.add(targetKey);
        return { sourceKey, targetKey, path, mimeType, bytes: item.bytes as number, sha256 };
    });
    const stagedKeys = strictArray(journal.stagedKeys, "恢复日志媒体进度").map((key) => storageKey(key, true));
    const expectedStagedKeys = media.slice(0, stagedKeys.length).map((item) => item.targetKey);
    if (stagedKeys.length > media.length || stagedKeys.some((key, index) => key !== expectedStagedKeys[index])) throw new Error("恢复日志媒体进度无效");
    if (journal.phase === "staging" && completedValues.some(Boolean)) throw new Error("恢复日志阶段与进度不一致");
    if (journal.phase === "committing" && stagedKeys.length !== media.length) throw new Error("恢复日志阶段与媒体进度不一致");
    const projects = canvas.projects;
    const parsedAssets = assets.assets;
    const ids = [id, ...projects.map((item) => restoreId(item.id, "画布标识")), ...parsedAssets.map((item) => restoreId(item.id, "资产标识")), ...imageLogs.map((item) => item.id as string), ...videoLogs.map((item) => item.id as string)];
    if (new Set(ids).size !== ids.length) throw new Error("恢复日志包含重复标识");
    const referencedKeys = collectRestoreStorageKeys({ projects, assets: parsedAssets, imageLogs, videoLogs });
    if (referencedKeys.size !== targetKeys.size || [...referencedKeys].some((key) => !targetKeys.has(key))) throw new Error("恢复日志媒体引用不完整");
    return {
        format: RESTORE_JOURNAL_FORMAT,
        id,
        phase: journal.phase,
        createdAt,
        sourceExportedAt,
        media,
        stagedKeys,
        data: { projects, assets: parsedAssets, imageLogs, videoLogs },
        completed: { canvas: completed.canvas as boolean, assets: completed.assets as boolean, imageLogs: completed.imageLogs as boolean, videoLogs: completed.videoLogs as boolean },
    };
}

function ensureRestoreChannel() {
    if (restoreChannel || typeof BroadcastChannel === "undefined") return;
    restoreChannel = new BroadcastChannel(userScopedResourceName(RESTORE_CHANNEL_NAME));
    restoreChannel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "changed" || typeof (message as { sourceId?: unknown }).sourceId !== "string") return;
        restoreListeners.forEach((listener) => listener(true));
    };
}

function notifyRestoreChanged() {
    restoreListeners.forEach((listener) => listener(false));
    ensureRestoreChannel();
    restoreChannel?.postMessage({ type: "changed", sourceId: restoreSourceId });
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
    return value as Record<string, unknown>;
}

function strictArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label}格式无效`);
    return value;
}

function strictKeys(record: Record<string, unknown>, keys: readonly string[], label: string) {
    const allowed = new Set(keys);
    if (Object.keys(record).some((key) => !allowed.has(key)) || keys.some((key) => !(key in record))) throw new Error(`${label}字段无效`);
}

function restoreId(value: unknown, label: string) {
    if (typeof value !== "string" || !value || value.length > 200 || /[\s\u0000-\u001f]/.test(value)) throw new Error(`${label}无效`);
    return value;
}

function isoDate(value: unknown, label: string) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label}无效`);
    return value;
}

function storageKey(value: unknown, generated: boolean) {
    if (typeof value !== "string" || value.length > 512 || !/^(image|video|audio|file|video-reference|audio-reference):[^\s]+$/.test(value)) throw new Error("恢复日志媒体键无效");
    if (generated && !/^[^:]+:[A-Za-z0-9_-]{21}$/.test(value)) throw new Error("恢复日志目标媒体键无效");
    return value;
}

function collectRestoreStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (/^(image|video|audio|file|video-reference|audio-reference):[^\s]+$/.test(value)) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    Object.values(value).forEach((item) => collectRestoreStorageKeys(item, keys));
    return keys;
}
