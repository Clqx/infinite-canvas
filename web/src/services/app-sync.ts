import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { mergeStoredGenerationSnapshot, readStoredGenerationSnapshot } from "@/services/generation-log-storage";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { downloadVersionedWebdavFile, downloadWebdavFile, uploadWebdavFile, WebdavConflictError, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { flushAppDataPersistence } from "@/services/app-data-persistence-actions";
import { createDomainManifest, parseDomainManifest, type AppSyncFile, type ParsedDomainManifest } from "@/services/app-sync-manifest";
import { sha256Blob } from "@/services/content-digest";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { compareTombstones, migrateAssetData, migrateCanvasData, parseTombstone, type SyncTombstone } from "@/services/app-data-schema";

type StoredLog = Record<string, unknown> & { id?: string };
export type AppSyncDomainKey = "canvas" | "assets" | "image-workbench" | "video-workbench";
type DomainKey = AppSyncDomainKey;
type CanvasDomainData = { projects: CanvasProject[]; projectTombstones: SyncTombstone[] };
type AssetDomainData = { assets: Asset[]; assetTombstones: SyncTombstone[] };
type LogDomainData = { logs: StoredLog[]; tombstones: SyncTombstone[] };

type DomainManifest<T> = ParsedDomainManifest<T, DomainKey> & { etag: string | null };

type SyncDomainOptions<T> = {
    key: DomainKey;
    label: string;
    localData: () => Promise<T>;
    emptyData: T;
    mergeData: (local: T, remote: T) => T;
    applyData?: (data: T) => Promise<T>;
};

type SyncDomainResult<T> = {
    data: T;
    mergedRemote: boolean;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
};

export type AppSyncResult = {
    syncedAt: string;
    mergedRemote: boolean;
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
};

export type AppSyncProgressEvent = {
    domain?: AppSyncDomainKey;
    label?: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

export type AppSyncProgress = (event: AppSyncProgressEvent) => void;

const FILE_CONCURRENCY = 3;
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncAppDataToWebdav(config: WebdavSyncConfig, onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await Promise.all([waitForHydration(useCanvasStore), waitForHydration(useAssetStore)]);

    const [canvas, assets, imageLogs, videoLogs] = await Promise.all([
        syncDomain<CanvasDomainData>(config, onProgress, {
            key: "canvas",
            label: "画布",
            emptyData: { projects: [], projectTombstones: [] },
            localData: async () => ({ projects: useCanvasStore.getState().projects, projectTombstones: useCanvasStore.getState().projectTombstones }),
            mergeData: (local, remote) => {
                const merged = mergeDomainRecords(local.projects, local.projectTombstones, remote.projects, remote.projectTombstones, "updatedAt");
                return { projects: merged.records, projectTombstones: merged.tombstones };
            },
            applyData: async (data) => {
                const current = useCanvasStore.getState();
                const merged = mergeDomainRecords(current.projects, current.projectTombstones, data.projects, data.projectTombstones, "updatedAt");
                const applied = { projects: merged.records, projectTombstones: merged.tombstones };
                useCanvasStore.getState().replaceProjects(applied.projects, applied.projectTombstones);
                await flushAppDataPersistence();
                return applied;
            },
        }),
        syncDomain<AssetDomainData>(config, onProgress, {
            key: "assets",
            label: "我的资产",
            emptyData: { assets: [], assetTombstones: [] },
            localData: async () => ({ assets: useAssetStore.getState().assets, assetTombstones: useAssetStore.getState().assetTombstones }),
            mergeData: (local, remote) => {
                const merged = mergeDomainRecords(local.assets, local.assetTombstones, remote.assets, remote.assetTombstones, "updatedAt");
                return { assets: merged.records, assetTombstones: merged.tombstones };
            },
            applyData: async (data) => {
                const current = useAssetStore.getState();
                const merged = mergeDomainRecords(current.assets, current.assetTombstones, data.assets, data.assetTombstones, "updatedAt");
                const applied = { assets: merged.records, assetTombstones: merged.tombstones };
                useAssetStore.getState().replaceAssets(await Promise.all(applied.assets.map(hydrateAsset)), applied.assetTombstones);
                await flushAppDataPersistence();
                return applied;
            },
        }),
        syncDomain<LogDomainData>(config, onProgress, {
            key: "image-workbench",
            label: "生图工作台",
            emptyData: { logs: [], tombstones: [] },
            localData: async () => readStoredGenerationSnapshot("image") as Promise<LogDomainData>,
            mergeData: (local, remote) => {
                const merged = mergeDomainRecords(local.logs, local.tombstones, remote.logs, remote.tombstones, "updatedAt");
                return { logs: merged.records, tombstones: merged.tombstones };
            },
            applyData: async (data) => (await mergeStoredGenerationSnapshot("image", data)) as LogDomainData,
        }),
        syncDomain<LogDomainData>(config, onProgress, {
            key: "video-workbench",
            label: "视频创作台",
            emptyData: { logs: [], tombstones: [] },
            localData: async () => readStoredGenerationSnapshot("video") as Promise<LogDomainData>,
            mergeData: (local, remote) => {
                const merged = mergeDomainRecords(local.logs, local.tombstones, remote.logs, remote.tombstones, "updatedAt");
                return { logs: merged.records, tombstones: merged.tombstones };
            },
            applyData: async (data) => (await mergeStoredGenerationSnapshot("video", data)) as LogDomainData,
        }),
    ]);

    const result = {
        syncedAt: new Date().toISOString(),
        mergedRemote: [canvas, assets, imageLogs, videoLogs].some((item) => item.mergedRemote),
        projects: canvas.data.projects.length,
        assets: assets.data.assets.length,
        imageLogs: imageLogs.data.logs.length,
        videoLogs: videoLogs.data.logs.length,
        files: canvas.files + assets.files + imageLogs.files + videoLogs.files,
        manifestBytes: canvas.manifestBytes + assets.manifestBytes + imageLogs.manifestBytes + videoLogs.manifestBytes,
        uploadedFiles: canvas.uploadedFiles + assets.uploadedFiles + imageLogs.uploadedFiles + videoLogs.uploadedFiles,
        uploadedBytes: canvas.uploadedBytes + assets.uploadedBytes + imageLogs.uploadedBytes + videoLogs.uploadedBytes,
    };
    emitProgress(onProgress, { stage: "同步完成", status: "success" });
    return result;
}

async function syncDomain<T>(config: WebdavSyncConfig, onProgress: AppSyncProgress | undefined, options: SyncDomainOptions<T>): Promise<SyncDomainResult<T>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取远端清单", status: "active" });
            const remoteManifest = await readDomainManifest(config, options.key, options.emptyData);
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取本地数据", status: "active" });
            const localData = await options.localData();
            let mergedData = remoteManifest ? options.mergeData(localData, remoteManifest.data) : localData;
            let stagedFiles: Array<{ item: AppSyncFile; blob: Blob }> = [];

            if (remoteManifest) {
                emitProgress(onProgress, { domain: options.key, label: options.label, stage: "下载缺失媒体", status: "active" });
                stagedFiles = await downloadMissingFiles(config, options.key, mergedData, remoteManifest.files, onProgress);
                mergedData = options.mergeData(await options.localData(), mergedData);
            }

            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "上传新增媒体", status: "active" });
            const uploaded = await uploadChangedFiles(config, options.key, mergedData, remoteManifest?.files || [], new Map(stagedFiles.map((item) => [item.item.storageKey, item.blob])), onProgress);
            const manifest = createDomainManifest(options.key, mergedData, uploaded.files);
            const manifestFile = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: `上传清单 ${formatBytes(manifestFile.size)}`, status: "active" });
            await uploadWebdavFile(config, domainPath(options.key, WEBDAV_MANIFEST_FILE_NAME), manifestFile, "application/json", remoteManifest?.etag ?? null);
            await verifyManifestCommit(config, options.key, manifestFile);
            for (const staged of stagedFiles) {
                await (staged.item.storageKey.startsWith("image:") ? setImageBlob(staged.item.storageKey, staged.blob) : setMediaBlob(staged.item.storageKey, staged.blob));
            }
            if (options.applyData) mergedData = await options.applyData(mergedData);
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "完成", current: 1, total: 1, status: "success" });

            return {
                data: mergedData,
                mergedRemote: Boolean(remoteManifest),
                files: uploaded.files.length,
                manifestBytes: manifestFile.size,
                uploadedFiles: uploaded.uploadedFiles,
                uploadedBytes: uploaded.uploadedBytes,
            };
        } catch (error) {
            if (error instanceof WebdavConflictError && attempt < 2) {
                emitProgress(onProgress, { domain: options.key, label: options.label, stage: `远端已更新，重新合并 (${attempt + 1}/2)`, status: "active" });
                continue;
            }
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: error instanceof Error ? error.message : "同步失败", status: "exception" });
            throw error;
        }
    }
    throw new WebdavConflictError("WebDAV 远端连续更新，已停止本次同步，请稍后重试");
}

async function readDomainManifest<T>(config: WebdavSyncConfig, domain: DomainKey, emptyData: T): Promise<DomainManifest<T> | null> {
    const remote = await downloadVersionedWebdavFile(config, domainPath(domain, WEBDAV_MANIFEST_FILE_NAME));
    if (!remote.file) return null;
    const parsed = parseDomainManifest(await remote.file.text(), domain, (value, version) => parseDomainData(domain, value, version, emptyData));
    return { ...parsed, etag: remote.etag };
}

async function downloadMissingFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: AppSyncFile[] = [];
    const storageKeys = collectStorageKeys(data);
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const localBlob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const remoteFile = remoteFileMap.get(storageKey);
        scanned += 1;
        if (localBlob) {
            if (remoteFile?.sha256 && (localBlob.size !== remoteFile.bytes || (await sha256Blob(localBlob)) !== remoteFile.sha256)) throw new Error(`WebDAV 同一 storageKey 对应不同文件内容: ${storageKey}`);
            if (remoteFile?.sha256) await verifyRemoteSyncFile(remoteFile, (path) => downloadWebdavFile(config, path));
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
            continue;
        }
        if (!remoteFile) throw new Error(`本地和 WebDAV 均缺少引用文件: ${storageKey}`);
        tasks.push(remoteFile);
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
    }
    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体已齐全", current: 1, total: 1, status: "active" });
        return [];
    }
    let downloaded = 0;
    return runWithConcurrency(tasks, FILE_CONCURRENCY, async (remoteFile) => {
        const blob = await downloadWebdavFile(config, remoteFile.path);
        if (!blob) throw new Error(`WebDAV 同步清单引用的文件不存在: ${remoteFile.path}`);
        if (blob.size !== remoteFile.bytes) throw new Error(`WebDAV 同步文件大小校验失败: ${remoteFile.path}`);
        if (remoteFile.sha256 && (await sha256Blob(blob)) !== remoteFile.sha256) throw new Error(`WebDAV 同步文件摘要校验失败: ${remoteFile.path}`);
        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, remoteFile.mimeType);
        downloaded += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载媒体", current: downloaded, total: tasks.length, status: "active" });
        return { item: remoteFile, blob: typedBlob };
    });
}

export async function verifyRemoteSyncFile(remoteFile: AppSyncFile, download: (path: string) => Promise<Blob | null>) {
    const blob = await download(remoteFile.path);
    if (!blob) throw new Error(`WebDAV 同步清单引用的文件不存在: ${remoteFile.path}`);
    if (blob.size !== remoteFile.bytes || !remoteFile.sha256 || (await sha256Blob(blob)) !== remoteFile.sha256) throw new Error(`WebDAV 同步文件校验失败: ${remoteFile.path}`);
}

async function uploadChangedFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], stagedFiles: ReadonlyMap<string, Blob>, onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const files: AppSyncFile[] = [];
    const fileByPath = new Map<string, AppSyncFile>();
    const tasks: Array<{ item: AppSyncFile; blob: Blob }> = [];
    let uploadedFiles = 0;
    let uploadedBytes = 0;

    const storageKeys = collectStorageKeys(data);
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const remoteFile = remoteFileMap.get(storageKey);
        const localBlob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const prepared = await prepareSyncFile(domain, storageKey, remoteFile, localBlob, stagedFiles.get(storageKey));
        const shared = fileByPath.get(prepared.item.path);
        const item = normalizeSharedSyncFile(prepared.item, shared);
        fileByPath.set(item.path, item);
        files.push(item);
        if (prepared.changed && prepared.blob) tasks.push({ item, blob: prepared.blob });
        scanned += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: storageKeys.length, status: "active" });
    }

    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体无需上传", current: 1, total: 1, status: "active" });
        return { files, uploadedFiles, uploadedBytes };
    }

    await runWithConcurrency(tasks, FILE_CONCURRENCY, async ({ item, blob }) => {
        try {
            await uploadWebdavFile(config, item.path, blob, item.mimeType, null);
        } catch (error) {
            if (!(error instanceof WebdavConflictError)) throw error;
            const existing = await downloadWebdavFile(config, item.path);
            if (!existing || existing.size !== item.bytes || (await sha256Blob(existing)) !== item.sha256) throw new Error(`WebDAV 内容寻址文件冲突: ${item.path}`);
        }
        uploadedFiles += 1;
        uploadedBytes += blob.size;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `上传媒体 ${formatBytes(blob.size)}`, current: uploadedFiles, total: tasks.length, status: "active" });
    });

    return { files, uploadedFiles, uploadedBytes };
}

export function normalizeSharedSyncFile(file: AppSyncFile, shared?: AppSyncFile): AppSyncFile {
    if (!shared) return file;
    if (file.path !== shared.path || file.sha256 !== shared.sha256 || file.bytes !== shared.bytes) throw new Error(`WebDAV 同步路径对应多个文件内容: ${file.path}`);
    return { ...file, mimeType: shared.mimeType };
}

export async function prepareSyncFile(domain: AppSyncDomainKey, storageKey: string, remoteFile: AppSyncFile | undefined, localBlob: Blob | null, stagedBlob?: Blob) {
    const blob = localBlob || stagedBlob || null;
    if (!blob) {
        if (remoteFile) return { item: remoteFile, blob: null, changed: false };
        throw new Error(`本地和 WebDAV 均缺少引用文件: ${storageKey}`);
    }
    const sha256 = await sha256Blob(blob);
    const item: AppSyncFile = {
        storageKey,
        path: domainPath(domain, `files/${sha256}.${fileExtension(blob.type, storageKey)}`),
        mimeType: blob.type || remoteFile?.mimeType || "application/octet-stream",
        bytes: blob.size,
        sha256,
    };
    return { item, blob, changed: !remoteFile || remoteFile.sha256 !== sha256 || remoteFile.path !== item.path };
}

async function verifyManifestCommit(config: WebdavSyncConfig, domain: DomainKey, expected: Blob) {
    const committed = await downloadVersionedWebdavFile(config, domainPath(domain, WEBDAV_MANIFEST_FILE_NAME));
    if (!committed.file || committed.file.size !== expected.size || (await sha256Blob(committed.file)) !== (await sha256Blob(expected))) throw new WebdavConflictError(`${domain} 同步清单写入后已发生变化`);
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

function mergeById<T extends { id?: string }>(local: T[], remote: T[], timeKey: string) {
    const items = new Map<string, T>();
    remote.forEach((item) => {
        const id = item.id || "";
        if (id) items.set(id, item);
    });
    local.forEach((item) => {
        const id = item.id || "";
        if (!id) return;
        const current = items.get(id);
        if (!current || getTime(item as Record<string, unknown>, timeKey) >= getTime(current as Record<string, unknown>, timeKey)) items.set(id, item);
    });
    return Array.from(items.values()).sort((a, b) => getTime(b as Record<string, unknown>, timeKey) - getTime(a as Record<string, unknown>, timeKey));
}

export function mergeDomainRecords<T extends { id?: string }>(localRecords: T[], localTombstones: SyncTombstone[], remoteRecords: T[], remoteTombstones: SyncTombstone[], timeKey: string) {
    const tombstones = mergeTombstoneLists(localTombstones || [], remoteTombstones || []);
    const tombstoneById = new Map(tombstones.map((item) => [item.id, item]));
    const records = mergeById(localRecords || [], remoteRecords || [], timeKey).filter((record) => {
        const id = record.id || "";
        const tombstone = tombstoneById.get(id);
        return !tombstone || getTime(record as Record<string, unknown>, timeKey) > Date.parse(tombstone.deletedAt);
    });
    return { records, tombstones };
}

function mergeTombstoneLists(local: SyncTombstone[], remote: SyncTombstone[]) {
    const merged = new Map<string, SyncTombstone>();
    for (const tombstone of [...remote, ...local]) {
        const existing = merged.get(tombstone.id);
        if (!existing || compareTombstones(tombstone, existing) > 0) merged.set(tombstone.id, tombstone);
    }
    return Array.from(merged.values());
}

function parseDomainData<T>(domain: DomainKey, value: unknown, version: 1 | 2, _emptyData: T): T {
    if (domain === "canvas") return migrateCanvasData(value, version === 2 ? 2 : 1) as T;
    if (domain === "assets") return migrateAssetData(value, version === 2 ? 2 : 1) as T;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${domain} sync data`);
    const record = value as Record<string, unknown>;
    const allowedKeys = version === 2 ? ["logs", "tombstones"] : ["logs"];
    if (Object.keys(record).some((key) => !allowedKeys.includes(key)) || !Array.isArray(record.logs)) throw new Error(`Invalid ${domain} sync data`);
    const logs = record.logs.map((log) => {
        if (!log || typeof log !== "object" || Array.isArray(log) || typeof (log as Record<string, unknown>).id !== "string" || !(log as Record<string, unknown>).id) throw new Error(`Invalid ${domain} generation record`);
        return log as StoredLog;
    });
    const tombstones =
        version === 2
            ? Array.isArray(record.tombstones)
                ? record.tombstones.map(parseTombstone)
                : (() => {
                      throw new Error(`Invalid ${domain} tombstones`);
                  })()
            : [];
    return { logs, tombstones } as T;
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (storageKeyPattern.test(value)) keys.add(value);
        return [...keys];
    }
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function domainPath(domain: DomainKey, path: string) {
    return `${domain}/${path}`;
}

function domainLabel(domain: DomainKey) {
    if (domain === "canvas") return "画布";
    if (domain === "assets") return "我的资产";
    if (domain === "image-workbench") return "生图工作台";
    return "视频创作台";
}

function emitProgress(onProgress: AppSyncProgress | undefined, event: AppSyncProgressEvent) {
    onProgress?.(event);
}

function getStringField(item: Record<string, unknown>, key: string) {
    const value = item[key];
    return typeof value === "string" ? value : "";
}

function getTime(item: Record<string, unknown>, key: string) {
    const value = item[key];
    if (typeof value === "number") return value;
    if (typeof value === "string") return Date.parse(value) || 0;
    return 0;
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return storageKey.startsWith("image:") ? "png" : "bin";
}

function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        }),
    );
    return results;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
