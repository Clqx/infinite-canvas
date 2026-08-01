import assert from "node:assert/strict";
import { test } from "node:test";

import { addTombstones, migrateAssetData, migrateCanvasData } from "./app-data-schema";

const timestamp = "2026-08-02T00:00:00.000Z";

function legacyProject() {
    return {
        id: "project",
        title: "Project",
        createdAt: timestamp,
        updatedAt: timestamp,
        nodes: [{ id: "node", type: "text", title: "Text", position: { x: 1, y: 2 }, width: 320, height: 180 }],
        connections: [],
    };
}

function legacyAsset() {
    return {
        id: "asset",
        kind: "image",
        title: "Image",
        coverUrl: "blob:image",
        tags: ["tag"],
        createdAt: timestamp,
        updatedAt: timestamp,
        data: { dataUrl: "blob:image", storageKey: "image:key", width: 100, height: 80, bytes: 12, mimeType: "image/png" },
    };
}

test("canvas version 1 migration fills only documented legacy defaults", () => {
    const migrated = migrateCanvasData({ projects: [legacyProject()] }, 1);

    assert.equal(migrated.projects.length, 1);
    assert.deepEqual(migrated.projects[0].chatSessions, []);
    assert.equal(migrated.projects[0].backgroundMode, "lines");
    assert.equal(migrated.projects[0].showImageInfo, false);
    assert.deepEqual(migrated.projects[0].viewport, { x: 0, y: 0, k: 1 });
    assert.deepEqual(migrated.projectTombstones, []);
});

test("canvas migration rejects corrupted collections, nodes, and future versions", () => {
    assert.throws(() => migrateCanvasData({ projects: null }, 1), /Invalid canvas projects/);
    assert.throws(() => migrateCanvasData({ projects: [{ ...legacyProject(), nodes: [{ ...legacyProject().nodes[0], width: 0 }] }] }, 1), /Invalid node width/);
    assert.throws(() => migrateCanvasData({ projects: [] }, 99), /Unsupported canvas state version/);
});

test("asset version 1 migration validates nested media fields and starts without tombstones", () => {
    const migrated = migrateAssetData({ assets: [legacyAsset()] }, 1);

    assert.equal(migrated.assets.length, 1);
    assert.deepEqual(migrated.assetTombstones, []);
    assert.throws(() => migrateAssetData({ assets: [{ ...legacyAsset(), data: { ...legacyAsset().data, bytes: -1 } }] }, 1), /Invalid asset bytes/);
});

test("version 2 migration validates persisted tombstones", () => {
    const tombstone = { id: "deleted", deletedAt: timestamp, eventId: "event" };

    assert.deepEqual(migrateCanvasData({ projects: [], projectTombstones: [tombstone] }, 2).projectTombstones, [tombstone]);
    assert.throws(() => migrateAssetData({ assets: [], assetTombstones: [{ ...tombstone, deletedAt: "invalid" }] }, 2), /Invalid tombstone deletedAt/);
});

test("adding tombstones keeps the newest deletion event for each id", () => {
    const current = [{ id: "same", deletedAt: "2026-08-01T00:00:00.000Z", eventId: "a" }];
    let sequence = 0;
    const next = addTombstones(current, ["same", "new", "new"], timestamp, () => `event-${++sequence}`);

    assert.equal(next.length, 2);
    assert.equal(next.find((item) => item.id === "same")?.deletedAt, timestamp);
    assert.equal(next.find((item) => item.id === "new")?.eventId, "event-2");
});
