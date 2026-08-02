import assert from "node:assert/strict";
import { test } from "node:test";

import { commitSyncSnapshot, mergeDomainRecords, normalizeSharedSyncFile, prepareSyncFile, verifyRemoteSyncFile } from "./app-sync";
import { sha256Blob } from "./content-digest";

test("domain merge keeps tombstones and lets deletion win at the same timestamp", () => {
    const deletedAt = "2026-08-02T00:00:00.000Z";
    const merged = mergeDomainRecords(
        [
            { id: "same", updatedAt: deletedAt },
            { id: "newer", updatedAt: "2026-08-03T00:00:00.000Z" },
        ],
        [],
        [],
        [
            { id: "same", deletedAt, eventId: "delete-same" },
            { id: "newer", deletedAt, eventId: "delete-older" },
        ],
        "updatedAt",
    );

    assert.deepEqual(
        merged.records.map((item) => item.id),
        ["newer"],
    );
    assert.equal(merged.tombstones.length, 2);
});

test("a staged version 1 remote file upgrades to a content-addressed version 2 entry", async () => {
    const storageKey = "image:legacy-remote";
    const stagedBlob = new Blob(["legacy remote media"], { type: "image/png" });
    const digest = await sha256Blob(stagedBlob);
    const prepared = await prepareSyncFile(
        "canvas",
        storageKey,
        {
            storageKey,
            path: "canvas/files/legacy.png",
            mimeType: "image/png",
            bytes: stagedBlob.size,
        },
        null,
        stagedBlob,
    );

    assert.equal(prepared.blob, stagedBlob);
    assert.equal(prepared.changed, true);
    assert.deepEqual(prepared.item, {
        storageKey,
        path: `canvas/files/${digest}.png`,
        mimeType: "image/png",
        bytes: stagedBlob.size,
        sha256: digest,
    });
});

test("remote media referenced by an unchanged manifest must still be complete", async () => {
    const blob = new Blob(["remote media"], { type: "image/png" });
    const sha256 = await sha256Blob(blob);
    const remoteFile = { storageKey: "image:key", path: `canvas/files/${sha256}.png`, mimeType: "image/png", bytes: blob.size, sha256 };

    await verifyRemoteSyncFile(remoteFile, async () => blob);
    await assert.rejects(
        verifyRemoteSyncFile(remoteFile, async () => null),
        /不存在/,
    );
    await assert.rejects(
        verifyRemoteSyncFile(remoteFile, async () => new Blob(["wrong"], { type: "image/png" })),
        /校验失败/,
    );
});

test("shared sync content paths use one canonical MIME description", () => {
    const shared = { storageKey: "image:first", path: "canvas/files/hash.png", mimeType: "image/png", bytes: 5, sha256: "a".repeat(64) };
    const normalized = normalizeSharedSyncFile({ ...shared, storageKey: "image:second", mimeType: "application/octet-stream" }, shared);

    assert.equal(normalized.mimeType, "image/png");
});

test("unified sync applies remote data only after the root pointer is committed and verified", async () => {
    const events: string[] = [];
    await commitSyncSnapshot({
        uploadManifests: async () => void events.push("manifests"),
        verifyLegacy: async () => void events.push("legacy-verified"),
        commitRoot: async () => void events.push("root-committed"),
        verifyRoot: async () => void events.push("root-verified"),
        applyLocal: async () => void events.push("local-applied"),
    });
    assert.deepEqual(events, ["manifests", "legacy-verified", "root-committed", "root-verified", "local-applied"]);

    events.length = 0;
    await assert.rejects(
        commitSyncSnapshot({
            uploadManifests: async () => void events.push("manifests"),
            verifyLegacy: async () => void events.push("legacy-verified"),
            commitRoot: async () => {
                events.push("root-failed");
                throw new Error("root write failed");
            },
            verifyRoot: async () => void events.push("root-verified"),
            applyLocal: async () => void events.push("local-applied"),
        }),
        /root write failed/,
    );
    assert.deepEqual(events, ["manifests", "legacy-verified", "root-failed"]);
});
