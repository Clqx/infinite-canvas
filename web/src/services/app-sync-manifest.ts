import { isSha256 } from "@/services/content-digest";

export const APP_SYNC_MANIFEST_VERSION = 2;
export const MAX_SYNC_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_FILES = 100_000;
const MAX_SYNC_FILE_BYTES = 16 * 1024 * 1024 * 1024;

export type AppSyncFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
    sha256?: string;
};

export type ParsedDomainManifest<T, D extends string = string> = {
    app: "infinite-canvas";
    version: 1 | typeof APP_SYNC_MANIFEST_VERSION;
    domain: D;
    exportedAt: string;
    data: T;
    files: AppSyncFile[];
};

export function parseDomainManifest<T, D extends string>(input: string, domain: D, parseData: (value: unknown, version: 1 | 2) => T): ParsedDomainManifest<T, D> {
    if (new Blob([input]).size > MAX_SYNC_MANIFEST_BYTES) throw new Error("WebDAV 同步清单超过大小限制");
    let parsed: unknown;
    try {
        parsed = JSON.parse(input);
    } catch {
        throw new Error("WebDAV 同步清单不是有效 JSON");
    }
    const root = strictRecord(parsed, "sync manifest");
    strictKeys(root, ["app", "version", "domain", "exportedAt", "data", "files"], "sync manifest");
    if (root.app !== "infinite-canvas" || root.domain !== domain) throw new Error(`${domain} 同步清单不属于当前应用或数据域`);
    if (root.version !== 1 && root.version !== APP_SYNC_MANIFEST_VERSION) throw new Error(`${domain} 同步清单版本不受支持`);
    const exportedAt = isoDate(root.exportedAt, "manifest exportedAt");
    const files = strictArray(root.files, "manifest files");
    if (files.length > MAX_SYNC_FILES) throw new Error("WebDAV 同步清单文件条目过多");
    const storageKeys = new Set<string>();
    const paths = new Map<string, AppSyncFile>();
    const normalizedFiles = files.map((value) => {
        const file = parseFile(value, domain, root.version as 1 | 2);
        if (storageKeys.has(file.storageKey)) throw new Error(`WebDAV 同步清单包含重复 storageKey: ${file.storageKey}`);
        const existing = paths.get(file.path);
        if (existing && (existing.sha256 !== file.sha256 || existing.bytes !== file.bytes || existing.mimeType !== file.mimeType)) throw new Error(`WebDAV 同步清单路径对应多个文件描述: ${file.path}`);
        storageKeys.add(file.storageKey);
        paths.set(file.path, file);
        return file;
    });
    return {
        app: "infinite-canvas",
        version: root.version as 1 | 2,
        domain,
        exportedAt,
        data: parseData(root.data, root.version as 1 | 2),
        files: normalizedFiles,
    };
}

export function createDomainManifest<T, D extends string>(domain: D, data: T, files: AppSyncFile[]): ParsedDomainManifest<T, D> {
    if (files.some((file) => !isSha256(file.sha256))) throw new Error("WebDAV 同步文件缺少有效 SHA-256");
    const storageKeys = new Set<string>();
    const paths = new Map<string, AppSyncFile>();
    for (const file of files) {
        if (storageKeys.has(file.storageKey)) throw new Error(`WebDAV 同步文件包含重复 storageKey: ${file.storageKey}`);
        const existing = paths.get(file.path);
        if (existing && (existing.sha256 !== file.sha256 || existing.bytes !== file.bytes || existing.mimeType !== file.mimeType)) throw new Error(`WebDAV 同步文件路径对应多个文件描述: ${file.path}`);
        storageKeys.add(file.storageKey);
        paths.set(file.path, file);
    }
    return { app: "infinite-canvas", version: APP_SYNC_MANIFEST_VERSION, domain, exportedAt: new Date().toISOString(), data, files };
}

function parseFile(value: unknown, domain: string, version: 1 | 2): AppSyncFile {
    const file = strictRecord(value, "manifest file");
    strictKeys(file, version === 1 ? ["storageKey", "path", "mimeType", "bytes"] : ["storageKey", "path", "mimeType", "bytes", "sha256"], "manifest file");
    const storageKey = nonEmptyString(file.storageKey, "file storageKey");
    if (!/^(image|video|audio|file|video-reference|audio-reference):[^\s]+$/.test(storageKey)) throw new Error("WebDAV 同步清单包含无效 storageKey");
    const path = nonEmptyString(file.path, "file path");
    if (path.length > 512 || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("WebDAV 同步清单包含非法文件路径");
    if (!path.startsWith(`${domain}/files/`)) throw new Error("WebDAV 同步清单文件路径不属于当前数据域");
    const mimeType = nonEmptyString(file.mimeType, "file mimeType");
    if (mimeType.length > 200 || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new Error("WebDAV 同步清单包含无效媒体类型");
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0 || (file.bytes as number) > MAX_SYNC_FILE_BYTES) throw new Error("WebDAV 同步清单包含无效文件大小");
    if (version === 2 && !isSha256(file.sha256)) throw new Error("WebDAV 同步清单包含无效 SHA-256");
    return { storageKey, path, mimeType, bytes: file.bytes as number, ...(version === 2 ? { sha256: file.sha256 as string } : {}) };
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
