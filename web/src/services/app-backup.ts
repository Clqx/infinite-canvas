import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { flushAppDataPersistence } from "@/services/app-data-persistence-actions";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { migrateAssetData, migrateCanvasData, parseTombstone, type SyncTombstone } from "@/services/app-data-schema";
import { withAuthoritativeAppData } from "@/services/app-data-persistence";
import { sha256Blob, isSha256 } from "@/services/content-digest";
import { withAllStoredGenerationSnapshots, type GenerationLogSnapshot } from "@/services/generation-log-storage";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export const APP_BACKUP_FORMAT_VERSION = 1;
export const MAX_APP_BACKUP_BYTES = 256 * 1024 * 1024;
export const MAX_APP_BACKUP_MEDIA_BYTES = 128 * 1024 * 1024;
const BACKUP_MANIFEST_PATH = "backup.json";
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export type AppBackupFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
    sha256: string;
};

export type AppBackupData = {
    canvas: { schemaVersion: 2; projects: CanvasProject[]; tombstones: SyncTombstone[] };
    assets: { schemaVersion: 2; assets: Asset[]; tombstones: SyncTombstone[] };
    imageWorkbench: { schemaVersion: 1; logs: Record<string, unknown>[]; tombstones: SyncTombstone[] };
    videoWorkbench: { schemaVersion: 1; logs: Record<string, unknown>[]; tombstones: SyncTombstone[] };
};

export type AppBackupManifest = {
    app: "infinite-canvas";
    backupFormatVersion: typeof APP_BACKUP_FORMAT_VERSION;
    exportedAt: string;
    data: AppBackupData;
    files: AppBackupFile[];
};

export type AppBackupSummary = {
    exportedAt: string;
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
    bytes: number;
};

export async function createAppBackup() {
    return withFlushedBackupSnapshot(flushAppDataPersistence, async () => {
        const snapshot = await withAuthoritativeAppData(async (appData) =>
            withAllStoredGenerationSnapshots(async (logs) => {
                const data: AppBackupData = {
                    canvas: { schemaVersion: 2, projects: migrateCanvasData({ projects: appData.projects, projectTombstones: appData.projectTombstones }, 2).projects, tombstones: appData.projectTombstones.map(parseTombstone) },
                    assets: { schemaVersion: 2, assets: migrateAssetData({ assets: appData.assets, assetTombstones: appData.assetTombstones }, 2).assets, tombstones: appData.assetTombstones.map(parseTombstone) },
                    imageWorkbench: { schemaVersion: 1, logs: logs.image.logs, tombstones: logs.image.tombstones },
                    videoWorkbench: { schemaVersion: 1, logs: logs.video.logs, tombstones: logs.video.tombstones },
                };
                const files: AppBackupFile[] = [];
                const fileByPath = new Map<string, AppBackupFile>();
                const blobs = new Map<string, Blob>();
                let totalBytes = 0;
                for (const storageKey of collectStorageKeys(data)) {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) throw new Error(`备份失败，缺少引用文件: ${storageKey}`);
                    const sha256 = await sha256Blob(blob);
                    const path = `files/${sha256}.${fileExtension(blob.type, storageKey)}`;
                    const shared = fileByPath.get(path);
                    const file = normalizeSharedBackupFile({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size, sha256 }, shared);
                    fileByPath.set(path, file);
                    files.push(file);
                    if (!blobs.has(path)) {
                        totalBytes += blob.size;
                        if (totalBytes > MAX_APP_BACKUP_MEDIA_BYTES) throw new Error("完整备份媒体超过 128MB 限制，请先减少大媒体或使用 WebDAV");
                        blobs.set(path, blob);
                    }
                }
                return { data, files, blobs };
            }),
        );
        const manifest: AppBackupManifest = { app: "infinite-canvas", backupFormatVersion: APP_BACKUP_FORMAT_VERSION, exportedAt: new Date().toISOString(), data: snapshot.data, files: snapshot.files };
        const archive = await createZip([{ name: BACKUP_MANIFEST_PATH, data: JSON.stringify(manifest, null, 2) }, ...Array.from(snapshot.blobs, ([name, data]) => ({ name, data }))]);
        if (archive.size > MAX_APP_BACKUP_BYTES) throw new Error("完整备份文件超过 256MB 限制");
        return { archive, summary: summarizeBackup(manifest) };
    });
}

export function normalizeSharedBackupFile(file: AppBackupFile, shared?: AppBackupFile): AppBackupFile {
    if (!shared) return file;
    if (file.path !== shared.path || file.sha256 !== shared.sha256 || file.bytes !== shared.bytes) throw new Error(`备份路径对应多个文件内容: ${file.path}`);
    return { ...file, mimeType: shared.mimeType };
}

export async function withFlushedBackupSnapshot<T>(flush: () => Promise<void>, readSnapshot: () => Promise<T>) {
    await flush();
    return readSnapshot();
}

export async function downloadAppBackup() {
    const backup = await createAppBackup();
    saveAs(backup.archive, `infinite-canvas-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    return backup.summary;
}

export async function verifyAppBackup(file: Blob): Promise<AppBackupSummary> {
    const entries = await readZip(file, { maxCompressedBytes: MAX_APP_BACKUP_BYTES, maxExpandedBytes: MAX_APP_BACKUP_BYTES + 8 * 1024 * 1024 });
    const manifestFile = entries.get(BACKUP_MANIFEST_PATH);
    if (!manifestFile || manifestFile.size > 8 * 1024 * 1024) throw new Error("备份包缺少有效 backup.json");
    const manifest = parseAppBackupManifest(await manifestFile.text());
    const referencedKeys = new Set(collectStorageKeys(manifest.data));
    const declaredKeys = new Set(manifest.files.map((item) => item.storageKey));
    if (referencedKeys.size !== declaredKeys.size || [...referencedKeys].some((key) => !declaredKeys.has(key))) throw new Error("备份清单的媒体引用不完整");
    const expectedPaths = new Set([BACKUP_MANIFEST_PATH, ...manifest.files.map((item) => item.path)]);
    if (entries.size !== expectedPaths.size || [...entries.keys()].some((path) => !expectedPaths.has(path))) throw new Error("备份包包含未声明或缺失的文件");
    const verifiedPaths = new Set<string>();
    for (const item of manifest.files) {
        if (verifiedPaths.has(item.path)) continue;
        const blob = entries.get(item.path);
        if (!blob || blob.size !== item.bytes || (await sha256Blob(blob)) !== item.sha256) throw new Error(`备份文件校验失败: ${item.path}`);
        verifiedPaths.add(item.path);
    }
    return summarizeBackup(manifest);
}

export function parseAppBackupManifest(input: string): AppBackupManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(input);
    } catch {
        throw new Error("备份清单不是有效 JSON");
    }
    const root = strictRecord(parsed, "backup manifest");
    strictKeys(root, ["app", "backupFormatVersion", "exportedAt", "data", "files"], "backup manifest");
    if (root.app !== "infinite-canvas" || root.backupFormatVersion !== APP_BACKUP_FORMAT_VERSION) throw new Error("备份格式版本不受支持");
    const exportedAt = isoDate(root.exportedAt, "backup exportedAt");
    const data = parseBackupData(root.data);
    const files = strictArray(root.files, "backup files").map(parseBackupFile);
    const keys = new Set<string>();
    const paths = new Map<string, AppBackupFile>();
    for (const file of files) {
        if (keys.has(file.storageKey)) throw new Error(`备份清单包含重复 storageKey: ${file.storageKey}`);
        const existing = paths.get(file.path);
        if (existing && (existing.sha256 !== file.sha256 || existing.bytes !== file.bytes || existing.mimeType !== file.mimeType)) throw new Error(`备份清单路径对应多个文件描述: ${file.path}`);
        keys.add(file.storageKey);
        paths.set(file.path, file);
    }
    return { app: "infinite-canvas", backupFormatVersion: APP_BACKUP_FORMAT_VERSION, exportedAt, data, files };
}

function parseBackupData(value: unknown): AppBackupData {
    const data = strictRecord(value, "backup data");
    strictKeys(data, ["canvas", "assets", "imageWorkbench", "videoWorkbench"], "backup data");
    const canvas = strictRecord(data.canvas, "backup canvas");
    const assets = strictRecord(data.assets, "backup assets");
    strictKeys(canvas, ["schemaVersion", "projects", "tombstones"], "backup canvas");
    strictKeys(assets, ["schemaVersion", "assets", "tombstones"], "backup assets");
    if (canvas.schemaVersion !== 2 || assets.schemaVersion !== 2) throw new Error("备份业务数据版本不受支持");
    const canvasData = migrateCanvasData({ projects: canvas.projects, projectTombstones: canvas.tombstones }, 2);
    const assetData = migrateAssetData({ assets: assets.assets, assetTombstones: assets.tombstones }, 2);
    return {
        canvas: { schemaVersion: 2, projects: canvasData.projects, tombstones: canvasData.projectTombstones },
        assets: { schemaVersion: 2, assets: assetData.assets, tombstones: assetData.assetTombstones },
        imageWorkbench: parseLogBackup(data.imageWorkbench, "image workbench"),
        videoWorkbench: parseLogBackup(data.videoWorkbench, "video workbench"),
    };
}

function parseLogBackup(value: unknown, label: string): AppBackupData["imageWorkbench"] {
    const data = strictRecord(value, label);
    strictKeys(data, ["schemaVersion", "logs", "tombstones"], label);
    if (data.schemaVersion !== 1) throw new Error(`Invalid ${label} schema version`);
    return { schemaVersion: 1, logs: parseLogs(data.logs, label), tombstones: strictArray(data.tombstones, `${label} tombstones`).map(parseTombstone) };
}

function parseLogs(value: unknown, label: string) {
    return strictArray(value, `${label} logs`).map((item) => {
        const log = strictRecord(item, `${label} log`);
        if (typeof log.id !== "string" || !log.id) throw new Error(`Invalid ${label} log id`);
        return log;
    });
}

function parseBackupFile(value: unknown): AppBackupFile {
    const file = strictRecord(value, "backup file");
    strictKeys(file, ["storageKey", "path", "mimeType", "bytes", "sha256"], "backup file");
    const storageKey = nonEmptyString(file.storageKey, "backup storageKey");
    if (!storageKeyPattern.test(storageKey)) throw new Error("备份清单包含无效 storageKey");
    const sha256 = file.sha256;
    if (!isSha256(sha256)) throw new Error("备份清单包含无效 SHA-256");
    const path = nonEmptyString(file.path, "backup file path");
    if (path !== `files/${sha256}.${fileExtension(String(file.mimeType || ""), storageKey)}`) throw new Error("备份清单包含无效内容寻址路径");
    const mimeType = nonEmptyString(file.mimeType, "backup mimeType");
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0 || (file.bytes as number) > MAX_APP_BACKUP_BYTES) throw new Error("备份清单包含无效文件大小");
    return { storageKey, path, mimeType, bytes: file.bytes as number, sha256 };
}

function collectStorageKeys(value: unknown, keys = new Set<string>()): string[] {
    if (typeof value === "string") {
        if (storageKeyPattern.test(value)) keys.add(value);
        return [...keys];
    }
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function summarizeBackup(manifest: AppBackupManifest): AppBackupSummary {
    return {
        exportedAt: manifest.exportedAt,
        projects: manifest.data.canvas.projects.length,
        assets: manifest.data.assets.assets.length,
        imageLogs: manifest.data.imageWorkbench.logs.length,
        videoLogs: manifest.data.videoWorkbench.logs.length,
        files: manifest.files.length,
        bytes: Array.from(new Map(manifest.files.map((item) => [item.path, item.bytes])).values()).reduce((sum, bytes) => sum + bytes, 0),
    };
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

function strictRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value as Record<string, unknown>;
}

function strictArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value;
}

function strictKeys(record: Record<string, unknown>, keys: readonly string[], label: string) {
    const allowed = new Set(keys);
    if (Object.keys(record).some((key) => !allowed.has(key)) || keys.some((key) => !(key in record))) throw new Error(`Invalid ${label} fields`);
}

function nonEmptyString(value: unknown, label: string) {
    if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
    return value;
}

function isoDate(value: unknown, label: string) {
    const text = nonEmptyString(value, label);
    if (!Number.isFinite(Date.parse(text))) throw new Error(`Invalid ${label}`);
    return text;
}
