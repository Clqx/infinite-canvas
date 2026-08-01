import assert from "node:assert/strict";
import { test } from "node:test";

import { createMediaGarbageCollector } from "./media-garbage-collector";

function memoryCandidates() {
    const values = new Map<string, unknown>();
    return {
        values,
        storage: {
            getItem: async (key: string) => values.get(key) ?? null,
            setItem: async (key: string, value: unknown) => void values.set(key, value),
            removeItem: async (key: string) => void values.delete(key),
        },
    };
}

test("unreferenced media requires two successful scans separated by the grace period", async () => {
    const candidates = memoryCandidates();
    let now = 1_000;
    const collector = createMediaGarbageCollector({ storage: candidates.storage, graceMs: 500, now: () => now });

    assert.deepEqual(await collector.findDeletions(["image:new"], new Set()), []);
    now += 499;
    assert.deepEqual(await collector.findDeletions(["image:new"], new Set()), []);
    now += 1;
    assert.deepEqual(await collector.findDeletions(["image:new"], new Set()), ["image:new"]);
});

test("a reference or a new write clears a pending deletion candidate", async () => {
    const candidates = memoryCandidates();
    let now = 1_000;
    const collector = createMediaGarbageCollector({ storage: candidates.storage, graceMs: 100, now: () => now });

    await collector.findDeletions(["video:kept"], new Set());
    assert.equal(candidates.values.has("video:kept"), true);
    await collector.findDeletions(["video:kept"], new Set(["video:kept"]));
    assert.equal(candidates.values.has("video:kept"), false);

    await collector.findDeletions(["video:rewritten"], new Set());
    await collector.protect("video:rewritten");
    now += 1_000;
    assert.deepEqual(await collector.findDeletions(["video:rewritten"], new Set()), []);
});

test("candidate storage failures abort collection before any deletion is returned", async () => {
    const collector = createMediaGarbageCollector({
        storage: {
            getItem: async () => {
                throw new Error("candidate database unavailable");
            },
            setItem: async () => undefined,
            removeItem: async () => undefined,
        },
    });

    await assert.rejects(collector.findDeletions(["image:unsafe"], new Set()), /candidate database unavailable/);
});
