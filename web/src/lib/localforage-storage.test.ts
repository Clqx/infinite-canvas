import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalForageStorage } from "./localforage-storage";

const KEY = "state";

function adapters(authoritativeValue: string | null, legacyValue: string | null) {
    let primary = authoritativeValue;
    let old = legacyValue;
    const calls = { primaryGets: 0, primarySets: 0, primaryRemoves: 0, legacyGets: 0, legacyRemoves: 0 };
    return {
        calls,
        authoritative: {
            getItem: async () => {
                calls.primaryGets += 1;
                return primary;
            },
            setItem: async (_name: string, value: string) => {
                calls.primarySets += 1;
                primary = value;
            },
            removeItem: async () => {
                calls.primaryRemoves += 1;
                primary = null;
            },
        },
        legacy: {
            getItem: () => {
                calls.legacyGets += 1;
                return old;
            },
            removeItem: () => {
                calls.legacyRemoves += 1;
                old = null;
            },
        },
        get primary() {
            return primary;
        },
        get old() {
            return old;
        },
    };
}

test("authoritative data wins over a conflicting legacy value", async () => {
    const backend = adapters("authoritative", "stale-legacy");
    const storage = createLocalForageStorage(backend);

    assert.equal(await storage.getItem(KEY), "authoritative");
    assert.equal(backend.calls.legacyGets, 0);
    assert.equal(backend.calls.primarySets, 0);
    assert.equal(backend.old, "stale-legacy");
});

test("authoritative read errors never fall back to legacy storage", async () => {
    const backend = adapters(null, "legacy");
    backend.authoritative.getItem = async () => {
        backend.calls.primaryGets += 1;
        throw new Error("indexeddb unavailable");
    };
    const storage = createLocalForageStorage(backend);

    await assert.rejects(Promise.resolve(storage.getItem(KEY)), /indexeddb unavailable/);
    assert.equal(backend.calls.legacyGets, 0);
    assert.equal(backend.calls.primarySets, 0);
});

test("a missing authoritative key migrates and verifies legacy data before cleanup", async () => {
    const backend = adapters(null, "legacy");
    const storage = createLocalForageStorage(backend);

    assert.equal(await storage.getItem(KEY), "legacy");
    assert.equal(backend.primary, "legacy");
    assert.equal(backend.old, null);
    assert.equal(backend.calls.primarySets, 1);
    assert.equal(backend.calls.primaryGets, 2);
    assert.equal(backend.calls.legacyRemoves, 1);
});

test("an empty authoritative string is present and is not replaced by legacy data", async () => {
    const backend = adapters("", "legacy");
    const storage = createLocalForageStorage(backend);

    assert.equal(await storage.getItem(KEY), "");
    assert.equal(backend.calls.legacyGets, 0);
});

test("migration keeps legacy data when the authoritative write does not commit", async () => {
    const backend = adapters(null, "legacy");
    backend.authoritative.setItem = async () => {
        backend.calls.primarySets += 1;
        throw new Error("quota exceeded");
    };
    const storage = createLocalForageStorage(backend);

    await assert.rejects(Promise.resolve(storage.getItem(KEY)), /Unable to migrate/);
    assert.equal(backend.primary, null);
    assert.equal(backend.old, "legacy");
    assert.equal(backend.calls.legacyRemoves, 0);
});

test("migration accepts a committed write that reported failure", async () => {
    const backend = adapters(null, "legacy");
    const commit = backend.authoritative.setItem;
    backend.authoritative.setItem = async (_name: string, value: string) => {
        await commit(KEY, value);
        throw new Error("transaction result lost");
    };
    const storage = createLocalForageStorage(backend);

    assert.equal(await storage.getItem(KEY), "legacy");
    assert.equal(backend.primary, "legacy");
    assert.equal(backend.old, null);
});

test("verified migration tolerates legacy cleanup failure", async () => {
    const backend = adapters(null, "legacy");
    backend.legacy.removeItem = () => {
        backend.calls.legacyRemoves += 1;
        throw new Error("legacy cleanup blocked");
    };
    const storage = createLocalForageStorage(backend);

    assert.equal(await storage.getItem(KEY), "legacy");
    assert.equal(backend.primary, "legacy");
    assert.equal(backend.old, "legacy");
});

test("normal write failures propagate without writing legacy storage", async () => {
    const backend = adapters("old", "legacy");
    backend.authoritative.setItem = async () => {
        backend.calls.primarySets += 1;
        throw new Error("write failed");
    };
    const storage = createLocalForageStorage(backend);

    await assert.rejects(Promise.resolve(storage.setItem(KEY, "new")), /write failed/);
    assert.equal(backend.primary, "old");
    assert.equal(backend.old, "legacy");
    assert.equal(backend.calls.legacyRemoves, 0);
});

test("authoritative remove failures propagate without deleting the legacy copy", async () => {
    const backend = adapters("saved", "legacy");
    backend.authoritative.removeItem = async () => {
        backend.calls.primaryRemoves += 1;
        throw new Error("remove failed");
    };
    const storage = createLocalForageStorage(backend);

    await assert.rejects(Promise.resolve(storage.removeItem(KEY)), /remove failed/);
    assert.equal(backend.primary, "saved");
    assert.equal(backend.old, "legacy");
    assert.equal(backend.calls.legacyRemoves, 0);
});

test("successful removal deletes authoritative and legacy copies", async () => {
    const backend = adapters("saved", "legacy");
    const storage = createLocalForageStorage(backend);

    await storage.removeItem(KEY);
    assert.equal(backend.primary, null);
    assert.equal(backend.old, null);
});

test("explicit removal reports legacy cleanup failures instead of allowing resurrection", async () => {
    const backend = adapters("saved", "legacy");
    backend.legacy.removeItem = () => {
        backend.calls.legacyRemoves += 1;
        throw new Error("legacy remove failed");
    };
    const storage = createLocalForageStorage(backend);

    await assert.rejects(Promise.resolve(storage.removeItem(KEY)), /legacy remove failed/);
    assert.equal(backend.primary, null);
    assert.equal(backend.old, "legacy");
});
