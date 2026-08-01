import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";

import { createBrowserExclusiveRunner, createReliableStateStorage, PersistenceHydrationRejectedError } from "./reliable-state-storage";

const KEY = "test-state";

function memoryStorage(initial: string | null = null) {
    let value = initial;
    return {
        storage: {
            getItem: async () => value,
            setItem: async (_key: string, next: string) => void (value = next),
            removeItem: async () => void (value = null),
        },
        get value() {
            return value;
        },
    };
}

function storedPayload(raw: string | null) {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as { format?: string; value?: string | null; __infiniteCanvasPersistence?: { format?: string; value?: string | null } };
        if (parsed.__infiniteCanvasPersistence?.format === "infinite-canvas-state-v1") return parsed.__infiniteCanvasPersistence.value ?? null;
        return parsed.format === "infinite-canvas-state-v1" ? (parsed.value ?? null) : raw;
    } catch {
        return raw;
    }
}

function storedGeneration(raw: string | null) {
    if (raw === null) return 0;
    const parsed = JSON.parse(raw) as { format?: string; generation?: number; __infiniteCanvasPersistence?: { format?: string; generation?: number } };
    if (parsed.__infiniteCanvasPersistence?.format === "infinite-canvas-state-v1") return parsed.__infiniteCanvasPersistence.generation ?? 0;
    return parsed.format === "infinite-canvas-state-v1" ? (parsed.generation ?? 0) : 0;
}

async function ready(storage: ReturnType<typeof createReliableStateStorage>) {
    await storage.getItem(KEY);
    storage.markHydrated();
}

function sharedExclusiveRunner() {
    let tail = Promise.resolve();
    return async <T>(operation: () => Promise<T>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => (release = resolve));
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    };
}

test("reliable storage serializes writes and coalesces queued snapshots to the latest value", async (t) => {
    let value: string | null = null;
    let active = 0;
    let maxActive = 0;
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => (releaseFirst = resolve));
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 0,
        retryDelaysMs: [60_000],
        storage: {
            getItem: async () => value,
            setItem: async (_key, next) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                writes.push(next);
                if (writes.length === 1) await firstWrite;
                value = next;
                active -= 1;
            },
            removeItem: async () => void (value = null),
        },
    });
    t.after(() => channel.dispose());
    await ready(channel);

    channel.setItem(KEY, "a");
    const flushing = channel.flush();
    await Promise.resolve();
    channel.setItem(KEY, "b");
    channel.setItem(KEY, "c");
    releaseFirst();
    await flushing;
    await channel.flush();

    assert.deepEqual(writes.map(storedPayload), ["a", "c"]);
    assert.equal(storedPayload(value), "c");
    assert.equal(storedGeneration(value), 2);
    assert.equal(maxActive, 1);
    assert.equal(channel.getStatus().dirty, false);
});

test("failed writes remain dirty and a manual retry persists the newest snapshot", async (t) => {
    let value: string | null = "old";
    let fail = true;
    const writes: string[] = [];
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 0,
        retryDelaysMs: [60_000],
        storage: {
            getItem: async () => value,
            setItem: async (_key, next) => {
                writes.push(next);
                if (fail) throw new Error("quota exceeded");
                value = next;
            },
            removeItem: async () => void (value = null),
        },
    });
    t.after(() => channel.dispose());
    await ready(channel);

    channel.setItem(KEY, "first");
    await assert.rejects(channel.flush(), /quota exceeded/);
    assert.equal(channel.hasDirtyData(), true);

    channel.setItem(KEY, "newest");
    fail = false;
    await channel.retryNow();

    assert.equal(storedPayload(value), "newest");
    assert.equal(channel.hasDirtyData(), false);
    assert.deepEqual(writes.map(storedPayload), ["first", "newest"]);
});

test("a newer snapshot queued during a failed write wins on retry", async (t) => {
    let value: string | null = "old";
    let fail = true;
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => (releaseWrite = resolve));
    const writes: string[] = [];
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 0,
        retryDelaysMs: [60_000],
        storage: {
            getItem: async () => value,
            setItem: async (_key, next) => {
                writes.push(next);
                if (writes.length === 1) await blockedWrite;
                if (fail) throw new Error("first write failed");
                value = next;
            },
            removeItem: async () => void (value = null),
        },
    });
    t.after(() => channel.dispose());
    await ready(channel);

    channel.setItem(KEY, "a");
    const firstFlush = channel.flush();
    await Promise.resolve();
    channel.setItem(KEY, "b");
    releaseWrite();
    await assert.rejects(firstFlush, /first write failed/);

    fail = false;
    await channel.retryNow();
    assert.equal(storedPayload(value), "b");
    assert.deepEqual(writes.map(storedPayload), ["a", "b"]);
    assert.equal(channel.hasDirtyData(), false);
});

test("a write that committed before reporting failure is accepted after readback", async (t) => {
    let value: string | null = null;
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 0,
        retryDelaysMs: [60_000],
        storage: {
            getItem: async () => value,
            setItem: async (_key, next) => {
                value = next;
                throw new Error("transaction result lost");
            },
            removeItem: async () => void (value = null),
        },
    });
    t.after(() => channel.dispose());
    await ready(channel);

    channel.setItem(KEY, "committed");
    await channel.flush();

    assert.equal(channel.getStatus().error, "");
    assert.equal(channel.hasDirtyData(), false);
    assert.equal(storedPayload(value), "committed");
});

test("flush bypasses debounce and rejects failed verification without discarding data", async (t) => {
    const backend = memoryStorage("old");
    let writes = 0;
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 60_000,
        retryDelaysMs: [60_000],
        storage: {
            getItem: backend.storage.getItem,
            setItem: async () => void (writes += 1),
            removeItem: backend.storage.removeItem,
        },
    });
    t.after(() => channel.dispose());
    await ready(channel);

    channel.setItem(KEY, "next");
    assert.equal(writes, 0);
    await assert.rejects(channel.flush(), /校验失败/);

    assert.equal(writes, 1);
    assert.equal(channel.hasDirtyData(), true);
});

test("hydration errors keep the write gate closed until a successful rehydrate", async (t) => {
    const backend = memoryStorage("saved");
    let writes = 0;
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 0,
        storage: {
            ...backend.storage,
            setItem: async (name, value) => {
                writes += 1;
                await backend.storage.setItem(name, value);
            },
        },
    });
    t.after(() => channel.dispose());

    channel.markHydrationError(new Error("corrupt JSON"));
    channel.setItem(KEY, "must-not-overwrite");
    await assert.rejects(channel.flush(), /阻止覆盖|尚未成功加载/);
    assert.equal(writes, 0);
    assert.equal(backend.value, "saved");

    await channel.getItem(KEY);
    channel.markHydrated();
    channel.setItem(KEY, "safe-after-rehydrate");
    await channel.flush();
    assert.equal(storedPayload(backend.value), "safe-after-rehydrate");
});

test("a schema migration queued after the authoritative read is persisted after hydration", async (t) => {
    const backend = memoryStorage('{"state":{"items":[]},"version":0}');
    const channel = createReliableStateStorage({ key: KEY, debounceMs: 60_000, storage: backend.storage });
    t.after(() => channel.dispose());

    await channel.getItem(KEY);
    channel.setItem(KEY, '{"state":{"items":[]},"version":1}');
    assert.equal(backend.value, '{"state":{"items":[]},"version":0}');
    assert.equal(channel.hasDirtyData(), true);

    channel.markHydrated();
    await channel.flush();

    assert.equal(storedPayload(backend.value), '{"state":{"items":[]},"version":1}');
    assert.equal(channel.getStatus().dirty, false);
});

test("a real Zustand version migration reaches authoritative storage", async (t) => {
    const backend = memoryStorage('{"state":{"items":["legacy"]},"version":0}');
    const channel = createReliableStateStorage({ key: KEY, debounceMs: 60_000, storage: backend.storage });
    t.after(() => channel.dispose());
    const store = createStore<{ items: string[] }>()(
        persist<{ items: string[] }>(() => ({ items: [] }), {
            name: KEY,
            storage: createJSONStorage(() => channel),
            version: 1,
            skipHydration: true,
            migrate: (state) => ({ items: [...(state as { items: string[] }).items, "migrated"] }),
            onRehydrateStorage: () => (_state, error) => {
                if (error) channel.markHydrationError(error);
                else channel.markHydrated();
            },
        }),
    );

    await store.persist.rehydrate();
    await channel.flush();

    assert.deepEqual(store.getState().items, ["legacy", "migrated"]);
    assert.deepEqual(JSON.parse(storedPayload(backend.value) || "null"), { state: { items: ["legacy", "migrated"] }, version: 1 });
    assert.deepEqual((JSON.parse(backend.value || "null") as { state: unknown; version: number }).state, { items: ["legacy", "migrated"] });
});

test("a stale tab cannot overwrite a newer value after retrying a failed write", async (t) => {
    let value: string | null = "initial";
    let failStaleTab = true;
    const runExclusive = sharedExclusiveRunner();
    const baseStorage = {
        getItem: async () => value,
        removeItem: async () => void (value = null),
    };
    const staleTab = createReliableStateStorage({
        key: KEY,
        debounceMs: 60_000,
        retryDelaysMs: [60_000],
        runExclusive,
        storage: {
            ...baseStorage,
            setItem: async (_key, next) => {
                if (failStaleTab) throw new Error("temporary failure");
                value = next;
            },
        },
    });
    const newerTab = createReliableStateStorage({
        key: KEY,
        debounceMs: 60_000,
        runExclusive,
        storage: {
            ...baseStorage,
            setItem: async (_key, next) => void (value = next),
        },
    });
    t.after(() => {
        staleTab.dispose();
        newerTab.dispose();
    });
    await Promise.all([ready(staleTab), ready(newerTab)]);

    staleTab.setItem(KEY, "stale");
    await assert.rejects(staleTab.flush(), /temporary failure/);
    newerTab.setItem(KEY, "newer");
    await newerTab.flush();

    failStaleTab = false;
    await assert.rejects(staleTab.retryNow(), /另一个标签页更新/);
    assert.equal(storedPayload(value), "newer");
    assert.equal(staleTab.hasDirtyData(), true);
    assert.equal(staleTab.getStatus().conflict, true);
    assert.equal(staleTab.getStatus().phase, "error");
});

test("durable generations reject an ABA write from a stale tab", async (t) => {
    let value: string | null = "original";
    const runExclusive = sharedExclusiveRunner();
    const storage = {
        getItem: async () => value,
        setItem: async (_key: string, next: string) => void (value = next),
        removeItem: async () => void (value = null),
    };
    const staleTab = createReliableStateStorage({ key: KEY, debounceMs: 60_000, runExclusive, storage });
    const activeTab = createReliableStateStorage({ key: KEY, debounceMs: 60_000, runExclusive, storage });
    t.after(() => {
        staleTab.dispose();
        activeTab.dispose();
    });
    await Promise.all([ready(staleTab), ready(activeTab)]);

    staleTab.setItem(KEY, "stale-pending");
    activeTab.setItem(KEY, "intermediate");
    await activeTab.flush();
    activeTab.setItem(KEY, "original");
    await activeTab.flush();

    await assert.rejects(staleTab.flush(), /另一个标签页更新/);
    assert.equal(storedPayload(value), "original");
    assert.equal(storedGeneration(value), 2);
});

test("browser storage fails closed when Web Locks are unavailable", async () => {
    const runExclusive = createBrowserExclusiveRunner(KEY, { isBrowser: true, locks: undefined });
    let ran = false;

    await assert.rejects(
        runExclusive(async () => {
            ran = true;
        }),
        /不支持安全的本地存储锁/,
    );
    assert.equal(ran, false);
});

test("rehydration cannot discard a pending durable revision", async (t) => {
    const backend = memoryStorage("initial");
    const channel = createReliableStateStorage({ key: KEY, debounceMs: 60_000, storage: backend.storage });
    t.after(() => channel.dispose());
    await ready(channel);

    channel.setItem(KEY, "pending");
    await assert.rejects(async () => void (await channel.getItem(KEY)), /尚未保存的本地数据/);

    assert.equal(channel.getStatus().ready, true);
    assert.equal(channel.hasDirtyData(), true);
    assert.equal(backend.value, "initial");
    await channel.flush();
    assert.equal(storedPayload(backend.value), "pending");
});

test("an overlapping hydration rejection cannot erase a newer pending write", async (t) => {
    let value: string | null = "old";
    let releaseRead!: () => void;
    const firstRead = new Promise<void>((resolve) => (releaseRead = resolve));
    let reads = 0;
    const channel = createReliableStateStorage({
        key: KEY,
        debounceMs: 60_000,
        storage: {
            getItem: async () => {
                reads += 1;
                if (reads === 1) await firstRead;
                return value;
            },
            setItem: async (_key, next) => void (value = next),
            removeItem: async () => void (value = null),
        },
    });
    t.after(() => channel.dispose());

    const firstHydration = channel.getItem(KEY);
    let rejected: unknown;
    await Promise.resolve(channel.getItem(KEY)).catch((error: unknown) => {
        rejected = error;
    });
    assert.ok(rejected instanceof PersistenceHydrationRejectedError);

    releaseRead();
    await firstHydration;
    assert.equal(channel.markHydrated(), true);
    channel.setItem(KEY, "new");

    assert.equal(channel.markHydrationError(rejected), false);
    assert.equal(channel.getStatus().ready, true);
    assert.equal(channel.hasDirtyData(), true);
    await channel.flush();
    assert.equal(storedPayload(value), "new");
});

test("a real Zustand dirty rehydrate keeps the store ready and flushes pending data", async (t) => {
    const backend = memoryStorage('{"state":{"items":["old"]},"version":0}');
    const channel = createReliableStateStorage({ key: KEY, debounceMs: 60_000, storage: backend.storage });
    t.after(() => channel.dispose());
    type State = { items: string[]; hydrated: boolean };
    let setHydrated = (_hydrated: boolean) => undefined;
    const store = createStore<State>()(
        persist<State>(() => ({ items: [], hydrated: false }), {
            name: KEY,
            storage: createJSONStorage(() => channel),
            skipHydration: true,
            partialize: (state) => ({ items: state.items, hydrated: false }),
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    if (channel.markHydrationError(error)) setHydrated(false);
                    return;
                }
                if (channel.markHydrated()) setHydrated(true);
            },
        }),
    );
    setHydrated = (hydrated) => void store.setState({ hydrated });

    await store.persist.rehydrate();
    await channel.flush();
    assert.equal(store.getState().hydrated, true);

    store.setState({ items: ["pending"] });
    assert.equal(channel.hasDirtyData(), true);
    await store.persist.rehydrate();

    assert.equal(store.getState().hydrated, true);
    assert.deepEqual(store.getState().items, ["pending"]);
    assert.equal(channel.hasDirtyData(), true);
    await channel.flush();
    assert.deepEqual((JSON.parse(storedPayload(backend.value) || "null") as { state: State }).state.items, ["pending"]);
});

test("remove waits for a verified deletion", async (t) => {
    const backend = memoryStorage("saved");
    const channel = createReliableStateStorage({ key: KEY, debounceMs: 0, storage: backend.storage });
    t.after(() => channel.dispose());
    await ready(channel);

    await channel.removeItem(KEY);

    assert.equal(storedPayload(backend.value), null);
    assert.equal(storedGeneration(backend.value), 1);
    assert.equal(channel.hasDirtyData(), false);
});
