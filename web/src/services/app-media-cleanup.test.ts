import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanupAppMediaAfterFlush } from "./app-media-cleanup";

test("metadata flush failure prevents all media garbage collection", async () => {
    const calls: string[] = [];
    await assert.rejects(
        cleanupAppMediaAfterFlush({
            flush: async () => {
                calls.push("flush");
                throw new Error("metadata write failed");
            },
            withUsedData: async (operation) => {
                calls.push("snapshot");
                await operation({});
            },
            cleanupImages: async () => void calls.push("images"),
            cleanupMedia: async () => void calls.push("media"),
        }),
        /metadata write failed/,
    );
    assert.deepEqual(calls, ["flush"]);
});

test("cleanup sees a post-flush snapshot before scanning both media stores", async () => {
    const calls: string[] = [];
    const usedData = { revision: 2 };
    await cleanupAppMediaAfterFlush({
        flush: async () => void calls.push("flush"),
        withUsedData: async (operation) => {
            calls.push("snapshot-start");
            await Promise.resolve();
            calls.push("snapshot");
            await operation(usedData);
        },
        cleanupImages: async (value) => {
            assert.equal(value, usedData);
            calls.push("images");
        },
        cleanupMedia: async (value) => {
            assert.equal(value, usedData);
            calls.push("media");
        },
    });
    assert.equal(calls[0], "flush");
    assert.deepEqual(calls.slice(1, 3), ["snapshot-start", "snapshot"]);
    assert.deepEqual(new Set(calls.slice(3)), new Set(["images", "media"]));
});

test("generation log read failure prevents all media garbage collection", async () => {
    const calls: string[] = [];
    await assert.rejects(
        cleanupAppMediaAfterFlush({
            flush: async () => void calls.push("flush"),
            withUsedData: async () => {
                calls.push("snapshot");
                throw new Error("generation logs unavailable");
            },
            cleanupImages: async () => void calls.push("images"),
            cleanupMedia: async () => void calls.push("media"),
        }),
        /generation logs unavailable/,
    );
    assert.deepEqual(calls, ["flush", "snapshot"]);
});

test("authoritative snapshot remains protected until both media scans finish", async () => {
    const calls: string[] = [];
    await cleanupAppMediaAfterFlush({
        flush: async () => void calls.push("flush"),
        withUsedData: async (operation) => {
            calls.push("lock-acquired");
            await operation({ revision: 3 });
            calls.push("lock-released");
        },
        cleanupImages: async () => {
            await Promise.resolve();
            calls.push("images");
        },
        cleanupMedia: async () => {
            await Promise.resolve();
            calls.push("media");
        },
    });
    assert.equal(calls[0], "flush");
    assert.equal(calls[1], "lock-acquired");
    assert.equal(calls.at(-1), "lock-released");
    assert.deepEqual(new Set(calls.slice(2, -1)), new Set(["images", "media"]));
});
