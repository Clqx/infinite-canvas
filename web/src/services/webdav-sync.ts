import type { WebdavSyncConfig } from "@/stores/use-config-store";

export const WEBDAV_MANIFEST_FILE_NAME = "manifest.json";
const WEBDAV_REQUEST_TIMEOUT_MS = 120000;
const ensuredDirectories = new Set<string>();

export class WebdavConflictError extends Error {
    constructor(message = "WebDAV 远端数据已更新，请重新读取后再同步") {
        super(message);
        this.name = "WebdavConflictError";
    }
}

export class WebdavVersionUnavailableError extends Error {
    constructor(message = "WebDAV 服务未提供可用的强 ETag，已停止双向同步") {
        super(message);
        this.name = "WebdavVersionUnavailableError";
    }
}

export class WebdavCapacityError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "WebdavCapacityError";
        this.status = status;
    }
}

export type VersionedWebdavFile = { file: Blob | null; etag: string | null };

export async function testWebdavConnection(config: WebdavSyncConfig) {
    await ensureWebdavDirectory(config);
    const response = await webdavFetch(config, "", { method: "PROPFIND", headers: { Depth: "0" } });
    if (response.ok || response.status === 207) return;
    await throwWebdavError(response, "WebDAV 连接测试失败");
}

export async function downloadWebdavSyncFile(config: WebdavSyncConfig) {
    return downloadWebdavFile(config, WEBDAV_MANIFEST_FILE_NAME);
}

export async function downloadWebdavFile(config: WebdavSyncConfig, path: string) {
    await ensureWebdavDirectory(config);
    const response = await webdavFetch(config, path, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) await throwWebdavError(response, "读取 WebDAV 同步文件失败");
    const file = await withTimeout(response.blob(), "读取 WebDAV 同步文件超时");
    return file.size ? file : null;
}

export async function uploadWebdavSyncFile(config: WebdavSyncConfig, file: Blob) {
    return uploadWebdavFile(config, WEBDAV_MANIFEST_FILE_NAME, file, "application/json");
}

export async function uploadWebdavFile(config: WebdavSyncConfig, path: string, file: Blob, contentType = "application/octet-stream", expectedEtag?: string | null) {
    if (!file.size) throw new Error("上传文件为空，已取消上传");
    await ensureWebdavDirectory(config);
    await ensureWebdavSubdirectory(config, path);
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (expectedEtag === null) headers["If-None-Match"] = "*";
    else if (expectedEtag !== undefined) {
        if (!isStrongEtag(expectedEtag)) throw new WebdavVersionUnavailableError();
        headers["If-Match"] = expectedEtag;
    }
    const response = await webdavFetch(config, path, {
        method: "PUT",
        headers,
        body: file,
    });
    if (!response.ok) await throwWebdavError(response, "上传 WebDAV 同步文件失败");
}

async function readStrongEtagFromProperties(config: WebdavSyncConfig, path: string) {
    const properties = await webdavFetch(config, path, {
        method: "PROPFIND",
        headers: { Depth: "0", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>',
    });
    if (!properties.ok && properties.status !== 207) return null;
    const xmlText = await properties.text();
    if (xmlText.length > 1024 * 1024) return null;
    const document = new DOMParser().parseFromString(xmlText, "application/xml");
    if (document.querySelector("parsererror")) return null;
    const etag = document.getElementsByTagNameNS("DAV:", "getetag")[0]?.textContent?.trim() || null;
    return isStrongEtag(etag) ? etag : null;
}

function isStrongEtag(value: string | null): value is string {
    return Boolean(value && !value.startsWith("W/") && /^"[^"\r\n]+"$/.test(value));
}

async function ensureWebdavDirectory(config: WebdavSyncConfig) {
    assertWebdavConfig(config);
    await ensureWebdavDirectoryPath(config, config.directory);
}

async function ensureWebdavSubdirectory(config: WebdavSyncConfig, path: string) {
    const directory = normalizePath(path).split("/").slice(0, -1).join("/");
    if (!directory) return;
    await ensureWebdavDirectoryPath(config, [config.directory, directory].filter(Boolean).join("/"));
}

async function ensureWebdavDirectoryPath(config: WebdavSyncConfig, directory: string) {
    const parts = normalizePath(directory).split("/").filter(Boolean);
    const cacheKey = `${config.url}:${parts.join("/")}`;
    if (ensuredDirectories.has(cacheKey)) return;
    let path = "";
    for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        const response = await webdavFetch({ ...config, directory: "" }, path, { method: "MKCOL" });
        if (response.ok || ((response.status === 405 || response.status === 423) && (await webdavDirectoryExists(config, path)))) continue;
        await throwWebdavError(response, "创建 WebDAV 远程目录失败");
    }
    ensuredDirectories.add(cacheKey);
}

async function webdavDirectoryExists(config: WebdavSyncConfig, path: string) {
    const response = await webdavFetch({ ...config, directory: "" }, path, { method: "PROPFIND", headers: { Depth: "0" } });
    return response.ok || response.status === 207;
}

async function webdavFetch(config: WebdavSyncConfig, path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    if (config.username || config.password) headers.set("Authorization", `Basic ${encodeBasicAuth(`${config.username}:${config.password}`)}`);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), WEBDAV_REQUEST_TIMEOUT_MS);
    try {
        const url = buildWebdavUrl(config, path);
        return await fetch(url, { ...init, headers, signal: controller.signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("WebDAV 请求超时，请检查网络或远端服务状态");
        if (error instanceof TypeError) throw new Error("无法连接 WebDAV，请检查地址、HTTPS 证书、CORS 或网络状态");
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

function buildWebdavUrl(config: WebdavSyncConfig, path: string) {
    const baseUrl = config.url.trim().replace(/\/+$/, "");
    const remotePath = [normalizePath(config.directory), normalizePath(path)].filter(Boolean).join("/");
    if (!remotePath) return baseUrl;
    return `${baseUrl}/${remotePath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizePath(path: string) {
    return path.trim().replace(/^\/+|\/+$/g, "");
}

function assertWebdavConfig(config: WebdavSyncConfig) {
    if (!config.url.trim()) throw new Error("请先填写 WebDAV 地址");
    let url: URL;
    try {
        url = new URL(config.url);
    } catch {
        throw new Error("WebDAV 地址格式不正确");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("WebDAV 必须使用 HTTPS；仅本机回环地址允许 HTTP");
}

export async function downloadVersionedWebdavFile(config: WebdavSyncConfig, path: string): Promise<VersionedWebdavFile> {
    await ensureWebdavDirectory(config);
    let response = await webdavFetch(config, path, { method: "GET" });
    if (response.status === 404) return { file: null, etag: null };
    if (!response.ok) await throwWebdavError(response, "读取 WebDAV 版本化文件失败");
    let etag = response.headers.get("etag");
    if (!isStrongEtag(etag)) {
        etag = await readStrongEtagFromProperties(config, path);
        if (!etag) throw new WebdavVersionUnavailableError();
        response = await webdavFetch(config, path, { method: "GET", headers: { "If-Match": etag } });
        if (!response.ok) await throwWebdavError(response, "读取 WebDAV 版本化文件失败");
        const responseEtag = response.headers.get("etag");
        if (responseEtag && (!isStrongEtag(responseEtag) || responseEtag !== etag)) throw new WebdavConflictError();
    }
    const file = await withTimeout(response.blob(), "读取 WebDAV 版本化文件超时");
    if (!file.size) throw new Error("WebDAV 版本化文件为空");
    return { file, etag };
}

async function throwWebdavError(response: Response, fallback: string): Promise<never> {
    if (response.status === 401 || response.status === 403) throw new Error("WebDAV 认证失败，请检查用户名、密码或应用密码");
    if (response.status === 404) throw new Error("WebDAV 路径不存在，请检查地址和远程目录");
    if (response.status === 409) throw new Error("WebDAV 目录状态已变化，请重新测试连接后重试");
    if (response.status === 412) throw new WebdavConflictError();
    if (response.status === 413) throw new WebdavCapacityError(413, "WebDAV 单文件超过服务端上传限制");
    if (response.status === 507) throw new WebdavCapacityError(507, "WebDAV 远端可用空间不足");
    if (response.status === 423) throw new Error("WebDAV 远端文件暂时被占用，请稍后重试");
    if (response.status === 429) throw new Error("WebDAV 请求过于频繁，请稍后重试");
    throw new Error(`${fallback}：${response.status}`);
}

function encodeBasicAuth(value: string) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

function withTimeout<T>(promise: Promise<T>, message: string) {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), WEBDAV_REQUEST_TIMEOUT_MS);
        promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
    });
}
