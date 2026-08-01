import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSET_STATE_STORAGE_KEY, CANVAS_STATE_STORAGE_KEY, assetStateStorage, canvasStateStorage, createAppDataPersistenceCoordinator, createAuthoritativeAppDataReader } from "./app-data-persistence";
import { createReliableStateStorage, type ReliableStateStorage } from "./reliable-state-storage";

const CANVAS_KEY = "test-canvas";
const ASSET_KEY = "test-assets";

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

function memoryChannel(key: string, initial: string | null = null, debounceMs = 60_000) {
    let value = initial;
    let failReads = false;
    let failWrites = false;
    const channel = createReliableStateStorage({
        key,
        debounceMs,
        retryDelaysMs: [60_000],
        storage: {
            getItem: async () => {
                if (failReads) throw new Error(`${key} read failed`);
                return value;
            },
            setItem: async (_name, next) => {
                if (failWrites) throw new Error(`${key} write failed`);
                value = next;
            },
            removeItem: async () => void (value = null),
        },
    });
    return {
        channel,
        get value() {
            return storedPayload(value);
        },
        set failReads(value: boolean) {
            failReads = value;
        },
        set failWrites(value: boolean) {
            failWrites = value;
        },
    };
}

async function failHydration(channel: ReliableStateStorage, key: string) {
    let failure: unknown;
    await Promise.resolve(channel.getItem(key)).catch((error: unknown) => {
        failure = error;
    });
    assert.ok(failure instanceof Error);
    assert.equal(channel.markHydrationError(failure), true);
}

async function hydrate(channel: ReliableStateStorage, key: string) {
    await channel.getItem(key);
    channel.markHydrated();
}

test("application channels are bound to the canonical Zustand persistence keys", async () => {
    assert.equal(CANVAS_STATE_STORAGE_KEY, "infinite-canvas:canvas_store");
    assert.equal(ASSET_STATE_STORAGE_KEY, "infinite-canvas:asset_store");
    await assert.rejects(async () => void (await canvasStateStorage.getItem("wrong-canvas-key")), /Unexpected persistence key/);
    await assert.rejects(async () => void (await assetStateStorage.getItem("wrong-asset-key")), /Unexpected persistence key/);
});

test("media cleanup reads the latest authoritative app references while holding the shared lock", async () => {
    let lockHeld = false;
    const values = new Map([
        [CANVAS_STATE_STORAGE_KEY, JSON.stringify({ state: { projects: [{ id: "old" }] }, version: 1 })],
        [ASSET_STATE_STORAGE_KEY, JSON.stringify({ state: { assets: [] }, version: 1 })],
    ]);
    const read = createAuthoritativeAppDataReader({
        storage: { getItem: async (key) => values.get(key) || null },
        runExclusive: async (operation) => {
            lockHeld = true;
            try {
                return await operation();
            } finally {
                lockHeld = false;
            }
        },
    });

    values.set(CANVAS_STATE_STORAGE_KEY, JSON.stringify({ state: { projects: [{ id: "new", nodes: [{ storageKey: "image:new" }] }] }, version: 1 }));
    values.set(ASSET_STATE_STORAGE_KEY, JSON.stringify({ state: { assets: [{ id: "asset", data: { storageKey: "video:new" } }] }, version: 1 }));

    await read(async (snapshot) => {
        assert.equal(lockHeld, true);
        assert.deepEqual(snapshot.projects, [{ id: "new", nodes: [{ storageKey: "image:new" }] }]);
        assert.deepEqual(snapshot.assets, [{ id: "asset", data: { storageKey: "video:new" } }]);
    });
    assert.equal(lockHeld, false);
});

test("aggregate snapshots are referentially stable and expose channel errors", async (t) => {
    const canvas = memoryChannel(CANVAS_KEY);
    const assets = memoryChannel(ASSET_KEY);
    const coordinator = createAppDataPersistenceCoordinator({ canvas: canvas.channel, assets: assets.channel });
    t.after(() => coordinator.dispose());

    const initial = coordinator.getStatus();
    assert.equal(coordinator.getStatus(), initial);
    assert.equal(initial.phase, "hydrating");
    assert.equal(initial.ready, false);

    const snapshots: (typeof initial)[] = [];
    const unsubscribe = coordinator.subscribe((status) => snapshots.push(status));
    await hydrate(canvas.channel, CANVAS_KEY);
    await hydrate(assets.channel, ASSET_KEY);

    const ready = coordinator.getStatus();
    assert.equal(ready.ready, true);
    assert.equal(ready.phase, "clean");
    assert.equal(coordinator.getStatus(), ready);
    assert.equal(snapshots.at(-1), ready);

    canvas.failReads = true;
    await failHydration(canvas.channel, CANVAS_KEY);
    const failed = coordinator.getStatus();
    assert.equal(failed.phase, "error");
    assert.equal(failed.hasError, true);
    assert.equal(failed.errors.canvas, `${CANVAS_KEY} read failed`);
    assert.match(failed.error, new RegExp(`画布：${CANVAS_KEY} read failed`));
    assert.equal(coordinator.hasErrors(), true);

    const snapshotCount = snapshots.length;
    unsubscribe();
    assets.failReads = true;
    await failHydration(assets.channel, ASSET_KEY);
    assert.equal(snapshots.length, snapshotCount);
});

test("checkpoints run synchronously in registration order and can be removed", (t) => {
    const canvas = memoryChannel(CANVAS_KEY);
    const assets = memoryChannel(ASSET_KEY);
    const coordinator = createAppDataPersistenceCoordinator({ canvas: canvas.channel, assets: assets.channel });
    t.after(() => coordinator.dispose());
    const calls: string[] = [];
    const removeFirst = coordinator.registerCheckpoint(() => calls.push("first"));
    coordinator.registerCheckpoint(() => calls.push("second"));

    coordinator.runCheckpoints();
    assert.deepEqual(calls, ["first", "second"]);

    removeFirst();
    coordinator.runCheckpoints();
    assert.deepEqual(calls, ["first", "second", "second"]);
});

test("flush runs checkpoints before persisting both latest snapshots", async (t) => {
    const canvas = memoryChannel(CANVAS_KEY);
    const assets = memoryChannel(ASSET_KEY);
    const coordinator = createAppDataPersistenceCoordinator({ canvas: canvas.channel, assets: assets.channel });
    t.after(() => coordinator.dispose());
    await Promise.all([hydrate(canvas.channel, CANVAS_KEY), hydrate(assets.channel, ASSET_KEY)]);
    let checkpointRan = false;
    coordinator.registerCheckpoint(() => {
        checkpointRan = true;
        canvas.channel.setItem(CANVAS_KEY, "canvas-latest");
        assets.channel.setItem(ASSET_KEY, "assets-latest");
    });

    const flushing = coordinator.flushAll();
    assert.equal(checkpointRan, true);
    await flushing;

    assert.equal(canvas.value, "canvas-latest");
    assert.equal(assets.value, "assets-latest");
    assert.equal(coordinator.hasDirtyData(), false);
    assert.equal(coordinator.getStatus().dirty, false);
});

test("retry clears an aggregate error after the failed channel becomes writable", async (t) => {
    const canvas = memoryChannel(CANVAS_KEY);
    const assets = memoryChannel(ASSET_KEY);
    const coordinator = createAppDataPersistenceCoordinator({ canvas: canvas.channel, assets: assets.channel });
    t.after(() => coordinator.dispose());
    await Promise.all([hydrate(canvas.channel, CANVAS_KEY), hydrate(assets.channel, ASSET_KEY)]);
    canvas.failWrites = true;
    canvas.channel.setItem(CANVAS_KEY, "canvas-next");
    assets.channel.setItem(ASSET_KEY, "assets-next");

    await assert.rejects(coordinator.flushAll(), /test-canvas write failed/);
    await assets.channel.flush();
    assert.equal(coordinator.hasDirtyData(), true);
    assert.equal(coordinator.hasErrors(), true);

    canvas.failWrites = false;
    await coordinator.retryAll();

    assert.equal(canvas.value, "canvas-next");
    assert.equal(assets.value, "assets-next");
    assert.equal(coordinator.hasDirtyData(), false);
    assert.equal(coordinator.hasErrors(), false);
    assert.equal(coordinator.getStatus().phase, "clean");
});

test("dispose unsubscribes and disposes both channels without coordinator timers", () => {
    const subscriptions = { canvas: 0, assets: 0 };
    const unsubscriptions = { canvas: 0, assets: 0 };
    const disposals = { canvas: 0, assets: 0 };
    const channel = (name: "canvas" | "assets") =>
        ({
            getItem: async () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
            flush: async () => undefined,
            retryNow: async () => undefined,
            markHydrated: () => true,
            markHydrationError: () => true,
            getStatus: () => ({ phase: "clean", ready: true, dirty: false, conflict: false, error: "", requestedRevision: 0, durableRevision: 0, lastSavedAt: "" }),
            hasDirtyData: () => false,
            subscribe: (listener: Parameters<ReliableStateStorage["subscribe"]>[0]) => {
                subscriptions[name] += 1;
                listener({ phase: "clean", ready: true, dirty: false, conflict: false, error: "", requestedRevision: 0, durableRevision: 0, lastSavedAt: "" });
                return () => void (unsubscriptions[name] += 1);
            },
            dispose: () => void (disposals[name] += 1),
        }) as ReliableStateStorage;
    const coordinator = createAppDataPersistenceCoordinator({ canvas: channel("canvas"), assets: channel("assets") });

    coordinator.dispose();
    coordinator.dispose();

    assert.deepEqual(subscriptions, { canvas: 1, assets: 1 });
    assert.deepEqual(unsubscriptions, { canvas: 1, assets: 1 });
    assert.deepEqual(disposals, { canvas: 1, assets: 1 });
});
