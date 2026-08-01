import assert from "node:assert/strict";
import { test } from "node:test";

import { filterDeletableGenerationLogIds, mergeStoredGenerationLogs, readAllStoredGenerationLogs, removeStoredGenerationLogs, withAllStoredGenerationLogs, type GenerationLogStore, type WritableGenerationLogStore } from "./generation-log-storage";
import { collectImageStorageKeys } from "./image-storage";
import { collectMediaStorageKeys } from "./file-storage";

function memoryStore(values: unknown[], error?: Error): GenerationLogStore {
    return {
        iterate: async <T, U>(callback: (value: T, key: string, iterationNumber: number) => U) => {
            if (error) throw error;
            values.forEach((value, index) => callback(value as T, String(index), index + 1));
            return undefined as U;
        },
    };
}

function writableMemoryStore(initial: Record<string, unknown>[]) {
    const values = new Map(initial.map((value) => [value.id as string, value]));
    const store: WritableGenerationLogStore = {
        getItem: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
        iterate: async <T, U>(callback: (value: T, key: string, iterationNumber: number) => U) => {
            let index = 0;
            for (const [key, value] of values) callback(value as T, key, ++index);
            return undefined as U;
        },
        removeItem: async (key: string) => void values.delete(key),
        setItem: async <T>(key: string, value: T) => {
            values.set(key, value as Record<string, unknown>);
            return value;
        },
    };
    return { store, values };
}

test("generation log references are read from both authoritative stores", async () => {
    const imageLog = { images: [{ storageKey: "image:output" }], references: [{ storageKey: "image:reference" }] };
    const videoLog = {
        video: { storageKey: "video:output" },
        references: [{ storageKey: "image:video-reference" }],
        videoReferences: [{ storageKey: "video-reference:input" }],
        audioReferences: [{ storageKey: "audio-reference:input" }],
    };

    const logs = await readAllStoredGenerationLogs({ image: memoryStore([imageLog]), video: memoryStore([videoLog]) });
    assert.deepEqual(logs, { imageLogs: [imageLog], videoLogs: [videoLog] });
    assert.deepEqual(collectImageStorageKeys(logs), new Set(["image:output", "image:reference", "image:video-reference"]));
    assert.deepEqual(collectMediaStorageKeys(logs), new Set(["image:output", "image:reference", "video:output", "image:video-reference", "video-reference:input", "audio-reference:input"]));
});

test("generation log read failures fail closed", async () => {
    await assert.rejects(readAllStoredGenerationLogs({ image: memoryStore([]), video: memoryStore([], new Error("logs unavailable")) }), /logs unavailable/);
});

test("generation log references stay locked while the cleanup callback runs", async () => {
    let lockHeld = false;
    await withAllStoredGenerationLogs(
        async (logs) => {
            assert.equal(lockHeld, true);
            assert.deepEqual(logs, { imageLogs: [{ id: "image" }], videoLogs: [{ id: "video" }] });
        },
        { image: memoryStore([{ id: "image" }]), video: memoryStore([{ id: "video" }]) },
        async (operation) => {
            lockHeld = true;
            try {
                return await operation();
            } finally {
                lockHeld = false;
            }
        },
    );
    assert.equal(lockHeld, false);
});

test("active video records are excluded from deletion", () => {
    const logs = [
        { id: "pending", status: "生成中" },
        { id: "done", status: "成功" },
        { id: "failed", status: "失败" },
    ];
    assert.deepEqual(filterDeletableGenerationLogIds(logs, ["pending", "done", "failed"]), ["done", "failed"]);
});

test("video deletion rechecks authoritative status inside the storage lock", async () => {
    let lockHeld = false;
    const memory = writableMemoryStore([
        { id: "pending", status: "生成中" },
        { id: "done", status: "成功" },
    ]);
    const removed = await removeStoredGenerationLogs("video", ["pending", "done"], memory.store, async (operation) => {
        lockHeld = true;
        try {
            return await operation();
        } finally {
            lockHeld = false;
        }
    });
    assert.deepEqual(removed, ["done"]);
    assert.equal(memory.values.has("pending"), true);
    assert.equal(memory.values.has("done"), false);
    assert.equal(lockHeld, false);
});

test("atomic log merge preserves records created after the earlier sync read", async () => {
    const memory = writableMemoryStore([
        { id: "new-pending", status: "生成中", createdAt: 30 },
        { id: "same", status: "成功", createdAt: 20 },
    ]);
    const merged = await mergeStoredGenerationLogs(
        "video",
        [
            { id: "remote", status: "成功", createdAt: 10 },
            { id: "same", status: "生成中", createdAt: 20 },
        ],
        memory.store,
        async (operation) => operation(),
    );
    assert.deepEqual(
        merged.map((log) => [log.id, log.status]),
        [
            ["new-pending", "生成中"],
            ["same", "成功"],
            ["remote", "成功"],
        ],
    );
    assert.equal(memory.values.has("new-pending"), true);
});
