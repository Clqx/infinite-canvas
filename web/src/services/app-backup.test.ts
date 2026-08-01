import assert from "node:assert/strict";
import { test } from "node:test";

import { createZip } from "@/lib/zip";
import { sha256Blob } from "./content-digest";
import { MAX_APP_BACKUP_BYTES, MAX_APP_BACKUP_MEDIA_BYTES, normalizeSharedBackupFile, parseAppBackupManifest, verifyAppBackup, withFlushedBackupSnapshot, type AppBackupManifest } from "./app-backup";

const timestamp = "2026-08-02T00:00:00.000Z";

function emptyManifest(): AppBackupManifest {
    return {
        app: "infinite-canvas",
        backupFormatVersion: 1,
        exportedAt: timestamp,
        data: {
            canvas: { schemaVersion: 2, projects: [], tombstones: [] },
            assets: { schemaVersion: 2, assets: [], tombstones: [] },
            imageWorkbench: { schemaVersion: 1, logs: [], tombstones: [] },
            videoWorkbench: { schemaVersion: 1, logs: [], tombstones: [] },
        },
        files: [],
    };
}

test("a complete backup package passes a no-write recovery rehearsal", async () => {
    const media = new Blob(["image"], { type: "image/png" });
    const sha256 = await sha256Blob(media);
    const path = `files/${sha256}.png`;
    const manifest = emptyManifest();
    manifest.data.canvas.projects.push({
        id: "project",
        title: "Project",
        createdAt: timestamp,
        updatedAt: timestamp,
        nodes: [{ id: "node", type: "image", title: "Image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:key" } }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    });
    manifest.files.push({ storageKey: "image:key", path, mimeType: "image/png", bytes: media.size, sha256 });
    const archive = await createZip([
        { name: "backup.json", data: JSON.stringify(manifest) },
        { name: path, data: media },
    ]);

    const summary = await verifyAppBackup(archive);

    assert.equal(summary.projects, 1);
    assert.equal(summary.files, 1);
    assert.equal(summary.bytes, media.size);
});

test("backup snapshot reads only after queued application data is flushed", async () => {
    const events: string[] = [];
    const result = await withFlushedBackupSnapshot(
        async () => {
            events.push("flush");
        },
        async () => {
            events.push("read");
            return "snapshot";
        },
    );

    assert.equal(result, "snapshot");
    assert.deepEqual(events, ["flush", "read"]);
    assert.ok(MAX_APP_BACKUP_MEDIA_BYTES < MAX_APP_BACKUP_BYTES);
});

test("backup generation normalizes MIME metadata for shared content paths", () => {
    const shared = { storageKey: "image:first", path: "files/hash.png", mimeType: "image/png", bytes: 5, sha256: "a".repeat(64) };
    const normalized = normalizeSharedBackupFile({ ...shared, storageKey: "image:second", mimeType: "application/octet-stream" }, shared);

    assert.equal(normalized.mimeType, "image/png");
});

test("backup verification rejects missing references, unknown versions, and undeclared files", async () => {
    const manifest = emptyManifest();
    manifest.data.imageWorkbench.logs.push({ id: "log", image: { storageKey: "image:missing" } });
    const missing = await createZip([{ name: "backup.json", data: JSON.stringify(manifest) }]);
    const extra = await createZip([
        { name: "backup.json", data: JSON.stringify(emptyManifest()) },
        { name: "files/extra.bin", data: "extra" },
    ]);

    await assert.rejects(verifyAppBackup(missing), /媒体引用不完整/);
    await assert.rejects(verifyAppBackup(extra), /未声明或缺失/);
    assert.throws(() => parseAppBackupManifest(JSON.stringify({ ...emptyManifest(), backupFormatVersion: 2 })), /版本不受支持/);
});
