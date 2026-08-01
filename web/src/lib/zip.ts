import { Unzip, UnzipInflate, zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export type ZipReadLimits = {
    maxCompressedBytes: number;
    maxEntries: number;
    maxEntryBytes: number;
    maxExpandedBytes: number;
    maxCompressionRatio: number;
    maxPathLength: number;
};

const DEFAULT_ZIP_LIMITS: ZipReadLimits = {
    maxCompressedBytes: 256 * 1024 * 1024,
    maxEntries: 10_000,
    maxEntryBytes: 256 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    maxCompressionRatio: 200,
    maxPathLength: 512,
};

export async function readZip(file: Blob, overrides: Partial<ZipReadLimits> = {}) {
    const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
    if (file.size <= 0 || file.size > limits.maxCompressedBytes) throw new Error("ZIP 文件为空或超过压缩大小限制");
    const entries = new Map<string, Blob>();
    let entryCount = 0;
    let expandedBytes = 0;
    let activeFiles = 0;
    let finishedInput = false;
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
        complete = resolve;
        fail = reject;
    });
    const maybeComplete = () => {
        if (finishedInput && activeFiles === 0) complete();
    };
    const unzip = new Unzip((entry) => {
        try {
            entryCount += 1;
            if (entryCount > limits.maxEntries) throw new Error("ZIP 文件条目过多");
            if (!Number.isSafeInteger(entry.size) || !Number.isSafeInteger(entry.originalSize)) throw new Error("ZIP 条目缺少可信大小信息");
            if (entry.originalSize! < 0 || entry.originalSize! > limits.maxEntryBytes) throw new Error("ZIP 单个条目超过展开大小限制");
            expandedBytes += entry.originalSize!;
            if (expandedBytes > limits.maxExpandedBytes) throw new Error("ZIP 总展开大小超过限制");
            const ratio = entry.size! > 0 ? entry.originalSize! / entry.size! : entry.originalSize! ? Number.POSITIVE_INFINITY : 1;
            if (ratio > limits.maxCompressionRatio) throw new Error("ZIP 条目压缩比超过限制");
            if (!validZipPath(entry.name, limits.maxPathLength) || entries.has(entry.name)) throw new Error("ZIP 包含非法或重复路径");
            const chunks: ArrayBuffer[] = [];
            let actualBytes = 0;
            activeFiles += 1;
            entry.ondata = (error, data, final) => {
                if (error) return fail(error);
                actualBytes += data.byteLength;
                if (actualBytes > entry.originalSize! || actualBytes > limits.maxEntryBytes) return fail(new Error("ZIP 条目实际大小超过声明限制"));
                if (data.byteLength) chunks.push(new Uint8Array(data).buffer);
                if (!final) return;
                if (actualBytes !== entry.originalSize) return fail(new Error("ZIP 条目实际大小与声明不一致"));
                entries.set(entry.name, new Blob(chunks));
                activeFiles -= 1;
                maybeComplete();
            };
            entry.start();
        } catch (error) {
            fail(error);
        }
    });
    unzip.register(UnzipInflate);
    const reader = file.stream().getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            unzip.push(value);
        }
        unzip.push(new Uint8Array(), true);
        finishedInput = true;
        maybeComplete();
        await completed;
        return entries;
    } catch (error) {
        throw error instanceof Error ? error : new Error("ZIP 文件无法读取");
    } finally {
        reader.releaseLock();
    }
}

function validZipPath(path: string, maxLength: number) {
    if (!path || path.length > maxLength || path.includes("\\") || path.startsWith("/") || path.includes("\0")) return false;
    return path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}
