import assert from "node:assert/strict";
import { test } from "node:test";

import { installAppDataPersistenceLifecycle } from "./app-data-lifecycle";

class FakeTarget {
    readonly listeners = new Map<string, Set<EventListener>>();

    addEventListener(type: string, listener: EventListener) {
        const listeners = this.listeners.get(type) || new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: EventListener) {
        this.listeners.get(type)?.delete(listener);
    }

    emit(type: string, event = new Event(type, { cancelable: true })) {
        this.listeners.get(type)?.forEach((listener) => listener(event));
        return event;
    }
}

function setup() {
    const documentTarget = Object.assign(new FakeTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const windowTarget = new FakeTarget();
    const events: string[] = [];
    let dirty = false;
    let error = false;
    const persistence = {
        flushAll: async () => void events.push("flush"),
        runCheckpoints: () => void events.push("checkpoint"),
        hasDirtyData: () => dirty,
        hasErrors: () => error,
    };
    const dispose = installAppDataPersistenceLifecycle({ documentTarget, windowTarget, persistence });
    return { documentTarget, windowTarget, events, dispose, setDirty: (value: boolean) => void (dirty = value), setError: (value: boolean) => void (error = value) };
}

test("hidden visibility and pagehide start a flush, while visible changes do not", async () => {
    const lifecycle = setup();
    lifecycle.documentTarget.emit("visibilitychange");
    assert.deepEqual(lifecycle.events, []);

    lifecycle.documentTarget.visibilityState = "hidden";
    lifecycle.documentTarget.emit("visibilitychange");
    lifecycle.windowTarget.emit("pagehide");
    await Promise.resolve();
    assert.deepEqual(lifecycle.events, ["flush", "flush"]);

    lifecycle.dispose();
    lifecycle.windowTarget.emit("pagehide");
    assert.deepEqual(lifecycle.events, ["flush", "flush"]);
});

test("beforeunload checkpoints first and warns only for dirty or failed persistence", () => {
    const lifecycle = setup();
    const cleanEvent = lifecycle.windowTarget.emit("beforeunload");
    assert.equal(cleanEvent.defaultPrevented, false);
    assert.deepEqual(lifecycle.events, ["checkpoint"]);

    lifecycle.setDirty(true);
    const dirtyEvent = lifecycle.windowTarget.emit("beforeunload");
    assert.equal(dirtyEvent.defaultPrevented, true);

    lifecycle.setDirty(false);
    lifecycle.setError(true);
    const errorEvent = lifecycle.windowTarget.emit("beforeunload");
    assert.equal(errorEvent.defaultPrevented, true);
});
