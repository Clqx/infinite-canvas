import { isSha256, sha256Blob } from "@/services/content-digest";
import { MAX_SYNC_MANIFEST_BYTES } from "@/services/app-sync-manifest";

export const APP_SYNC_ROOT_FILE_NAME = "sync-root.json";
export const APP_SYNC_ROOT_VERSION = 1;
export const MAX_APP_SYNC_ROOT_BYTES = 64 * 1024;
export const APP_SYNC_DOMAIN_KEYS = ["canvas", "assets", "image-workbench", "video-workbench"] as const;

export type AppSyncDomainKey = (typeof APP_SYNC_DOMAIN_KEYS)[number];

export type AppSyncManifestPointer = {
    path: string;
    bytes: number;
    sha256: string;
};

export type AppSyncRoot = {
    app: "infinite-canvas";
    version: typeof APP_SYNC_ROOT_VERSION;
    snapshotId: string;
    committedAt: string;
    manifests: Record<AppSyncDomainKey, AppSyncManifestPointer>;
};

export async function describeSnapshotManifest(path: string, file: Blob): Promise<AppSyncManifestPointer> {
    if (!file.size || file.size > MAX_SYNC_MANIFEST_BYTES) throw new Error("WebDAV 快照清单大小无效");
    return { path, bytes: file.size, sha256: await sha256Blob(file) };
}

export function createAppSyncRoot(snapshotId: string, manifests: Record<AppSyncDomainKey, AppSyncManifestPointer>, committedAt = new Date().toISOString()): AppSyncRoot {
    const root: AppSyncRoot = { app: "infinite-canvas", version: APP_SYNC_ROOT_VERSION, snapshotId, committedAt, manifests };
    return parseAppSyncRoot(JSON.stringify(root));
}

export function parseAppSyncRoot(input: string): AppSyncRoot {
    if (new Blob([input]).size > MAX_APP_SYNC_ROOT_BYTES) throw new Error("WebDAV 根指针超过大小限制");
    let parsed: unknown;
    try {
        parsed = JSON.parse(input);
    } catch {
        throw new Error("WebDAV 根指针不是有效 JSON");
    }
    const root = strictRecord(parsed, "sync root");
    strictKeys(root, ["app", "version", "snapshotId", "committedAt", "manifests"], "sync root");
    if (root.app !== "infinite-canvas" || root.version !== APP_SYNC_ROOT_VERSION) throw new Error("WebDAV 根指针版本不受支持");
    const snapshotId = nonEmptyString(root.snapshotId, "snapshotId");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(snapshotId)) throw new Error("WebDAV 根指针快照标识无效");
    const committedAt = isoDate(root.committedAt, "committedAt");
    const manifestRecord = strictRecord(root.manifests, "sync root manifests");
    strictKeys(manifestRecord, APP_SYNC_DOMAIN_KEYS, "sync root manifests");
    const manifests = Object.fromEntries(APP_SYNC_DOMAIN_KEYS.map((domain) => [domain, parseManifestPointer(manifestRecord[domain], snapshotId, domain)])) as Record<AppSyncDomainKey, AppSyncManifestPointer>;
    return { app: "infinite-canvas", version: APP_SYNC_ROOT_VERSION, snapshotId, committedAt, manifests };
}

export async function verifySnapshotManifest(pointer: AppSyncManifestPointer, file: Blob | null) {
    if (!file || file.size !== pointer.bytes || (await sha256Blob(file)) !== pointer.sha256) throw new Error(`WebDAV 快照清单校验失败: ${pointer.path}`);
}

function parseManifestPointer(value: unknown, snapshotId: string, domain: AppSyncDomainKey): AppSyncManifestPointer {
    const pointer = strictRecord(value, `${domain} manifest pointer`);
    strictKeys(pointer, ["path", "bytes", "sha256"], `${domain} manifest pointer`);
    const path = nonEmptyString(pointer.path, `${domain} manifest path`);
    if (path !== `snapshots/${snapshotId}/${domain}.json`) throw new Error("WebDAV 根指针包含无效清单路径");
    if (!Number.isSafeInteger(pointer.bytes) || (pointer.bytes as number) <= 0 || (pointer.bytes as number) > MAX_SYNC_MANIFEST_BYTES) throw new Error("WebDAV 根指针包含无效清单大小");
    if (!isSha256(pointer.sha256)) throw new Error("WebDAV 根指针包含无效清单摘要");
    return { path, bytes: pointer.bytes as number, sha256: pointer.sha256 };
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value as Record<string, unknown>;
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
