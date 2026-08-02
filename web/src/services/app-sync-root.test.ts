import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_SYNC_DOMAIN_KEYS, createAppSyncRoot, describeSnapshotManifest, MAX_APP_SYNC_ROOT_BYTES, parseAppSyncRoot, verifySnapshotManifest, type AppSyncManifestPointer } from "./app-sync-root";

const snapshotId = "snapshot_12345678";

async function pointers() {
    return Object.fromEntries(
        await Promise.all(
            APP_SYNC_DOMAIN_KEYS.map(async (domain) => {
                const file = new Blob([domain]);
                return [domain, await describeSnapshotManifest(`snapshots/${snapshotId}/${domain}.json`, file)];
            }),
        ),
    ) as Record<(typeof APP_SYNC_DOMAIN_KEYS)[number], AppSyncManifestPointer>;
}

test("a root pointer names one complete immutable four-domain snapshot", async () => {
    const root = createAppSyncRoot(snapshotId, await pointers(), "2026-08-02T00:00:00.000Z");
    const parsed = parseAppSyncRoot(JSON.stringify(root));

    assert.equal(parsed.snapshotId, snapshotId);
    assert.deepEqual(Object.keys(parsed.manifests), APP_SYNC_DOMAIN_KEYS);
});

test("root parsing rejects partial sets, path changes, and unknown fields", async () => {
    const root = createAppSyncRoot(snapshotId, await pointers(), "2026-08-02T00:00:00.000Z");
    const partial = structuredClone(root) as Record<string, unknown> & { manifests: Record<string, unknown> };
    delete partial.manifests.assets;
    assert.throws(() => parseAppSyncRoot(JSON.stringify(partial)), /fields/);

    const changedPath = structuredClone(root);
    changedPath.manifests.canvas.path = "canvas/manifest.json";
    assert.throws(() => parseAppSyncRoot(JSON.stringify(changedPath)), /路径/);

    assert.throws(() => parseAppSyncRoot(JSON.stringify({ ...root, extra: true })), /fields/);
    assert.throws(() => parseAppSyncRoot(" ".repeat(MAX_APP_SYNC_ROOT_BYTES + 1)), /大小限制/);
});

test("snapshot manifest verification checks bytes and digest", async () => {
    const file = new Blob(["canvas snapshot"]);
    const pointer = await describeSnapshotManifest(`snapshots/${snapshotId}/canvas.json`, file);

    await verifySnapshotManifest(pointer, file);
    await assert.rejects(verifySnapshotManifest(pointer, new Blob(["changed snapshot"])), /校验失败/);
});
