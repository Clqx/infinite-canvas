import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppBackupManifest } from "./app-backup";
import { collectAppRestoreMediaKeys, commitRestoreSteps, parseAppRestoreJournal, prepareAppRestoreJournal, removeVerifiedRestoreJournal, verifyRestoreMediaBlob } from "./app-restore";
import { sha256Blob } from "./content-digest";

const timestamp = "2026-08-02T00:00:00.000Z";

function backupManifest(): AppBackupManifest {
    return {
        app: "infinite-canvas",
        backupFormatVersion: 1,
        exportedAt: timestamp,
        data: {
            canvas: {
                schemaVersion: 2,
                projects: [
                    {
                        id: "old-project",
                        title: "Project",
                        createdAt: timestamp,
                        updatedAt: timestamp,
                        nodes: [{ id: "node", type: "image", title: "Image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:old-media" } }],
                        connections: [],
                        chatSessions: [],
                        activeChatId: null,
                        backgroundMode: "lines",
                        showImageInfo: false,
                        viewport: { x: 0, y: 0, k: 1 },
                    },
                ],
                tombstones: [{ id: "deleted-project", deletedAt: timestamp, eventId: "delete-project" }],
            },
            assets: {
                schemaVersion: 2,
                assets: [
                    {
                        id: "old-asset",
                        kind: "image",
                        title: "Asset",
                        coverUrl: "blob:old",
                        tags: [],
                        createdAt: timestamp,
                        updatedAt: timestamp,
                        data: { dataUrl: "blob:old", storageKey: "image:old-media", width: 1, height: 1, bytes: 5, mimeType: "image/png" },
                    },
                ],
                tombstones: [],
            },
            imageWorkbench: { schemaVersion: 1, logs: [{ id: "old-image-log", createdAt: timestamp, image: { storageKey: "image:old-media" } }], tombstones: [] },
            videoWorkbench: { schemaVersion: 1, logs: [{ id: "old-video-log", createdAt: timestamp }], tombstones: [] },
        },
        files: [{ storageKey: "image:old-media", path: `files/${"a".repeat(64)}.png`, mimeType: "image/png", bytes: 5, sha256: "a".repeat(64) }],
    };
}

test("copy restore assigns new ids and rewrites every persisted media reference", async () => {
    const ids = ["new-media", "new-project", "new-asset", "new-image-log", "new-video-log", "journal-id"];
    const journal = await prepareAppRestoreJournal(backupManifest(), {
        idFactory: () => ids.shift() || "unexpected",
        now: "2026-08-03T00:00:00.000Z",
        reservedIds: [],
        storageKeyExists: async () => false,
    });

    assert.equal(journal.media[0].targetKey, "image:new-media");
    assert.equal(journal.data.projects[0].id, "new-project");
    assert.equal(journal.data.assets[0].id, "new-asset");
    assert.equal(journal.data.imageLogs[0].id, "new-image-log");
    assert.equal(journal.data.videoLogs[0].id, "new-video-log");
    assert.equal(journal.id, "journal-id");
    assert.equal((journal.data.projects[0].nodes[0].metadata as { storageKey: string }).storageKey, "image:new-media");
    assert.equal(journal.data.assets[0].kind === "image" ? journal.data.assets[0].data.storageKey : "", "image:new-media");
    assert.equal((journal.data.imageLogs[0].image as { storageKey: string }).storageKey, "image:new-media");
    assert.equal(journal.data.projects[0].title, "Project（恢复副本）");
    assert.equal(journal.phase, "staging");
});

test("restore commit resumes after a failed step without repeating completed domains", async () => {
    const journal = await prepareAppRestoreJournal(
        {
            ...backupManifest(),
            data: {
                canvas: { schemaVersion: 2, projects: [], tombstones: [] },
                assets: { schemaVersion: 2, assets: [], tombstones: [] },
                imageWorkbench: { schemaVersion: 1, logs: [], tombstones: [] },
                videoWorkbench: { schemaVersion: 1, logs: [], tombstones: [] },
            },
            files: [],
        },
        { idFactory: () => "journal-id", now: timestamp, reservedIds: [], storageKeyExists: async () => false },
    );
    const events: string[] = [];
    const persist = async () => {
        events.push("persist");
    };

    await assert.rejects(
        commitRestoreSteps(
            journal,
            {
                canvas: async () => {
                    events.push("canvas");
                },
                assets: async () => {
                    events.push("assets-failed");
                    throw new Error("write failed");
                },
                imageLogs: async () => {
                    events.push("image");
                },
                videoLogs: async () => {
                    events.push("video");
                },
                verify: async () => {
                    events.push("verify");
                },
            },
            persist,
        ),
        /write failed/,
    );
    assert.deepEqual(journal.completed, { canvas: true, assets: false, imageLogs: false, videoLogs: false });

    await commitRestoreSteps(
        journal,
        {
            canvas: async () => {
                events.push("canvas-repeated");
            },
            assets: async () => {
                events.push("assets");
            },
            imageLogs: async () => {
                events.push("image");
            },
            videoLogs: async () => {
                events.push("video");
            },
            verify: async () => {
                events.push("verify");
            },
        },
        persist,
    );

    assert.equal(events.includes("canvas-repeated"), false);
    assert.deepEqual(journal.completed, { canvas: true, assets: true, imageLogs: true, videoLogs: true });
    assert.deepEqual(events.slice(-7), ["assets", "persist", "image", "persist", "video", "persist", "verify"]);
});

test("copy restore protects every planned media key from cleanup", async () => {
    const ids = ["planned-media", "new-project", "new-asset", "new-image-log", "new-video-log", "journal-id"];
    const journal = await prepareAppRestoreJournal(backupManifest(), {
        idFactory: () => ids.shift() || "unexpected",
        now: timestamp,
        reservedIds: [],
        storageKeyExists: async () => false,
    });

    assert.deepEqual(collectAppRestoreMediaKeys(journal), ["image:planned-media"]);
});

test("copy restore converts unfinished video records into non-running results", async () => {
    const manifest = backupManifest();
    manifest.data.videoWorkbench.logs = [{ id: "running-video", createdAt: timestamp, status: "生成中", task: { id: "remote-task" } }];
    const ids = ["new-media", "new-project", "new-asset", "new-image-log", "new-video-log", "journal-id"];
    const journal = await prepareAppRestoreJournal(manifest, {
        idFactory: () => ids.shift() || "unexpected",
        now: timestamp,
        reservedIds: [],
        storageKeyExists: async () => false,
    });

    assert.equal(journal.data.videoLogs[0].status, "失败");
    assert.equal(journal.data.videoLogs[0].error, "该任务来自备份副本，请重新生成");
    assert.equal("task" in journal.data.videoLogs[0], false);
});

test("restore media verification rejects same-size content changes", async () => {
    const blob = new Blob(["valid"]);
    const plan = {
        sourceKey: "image:source",
        targetKey: "image:target",
        path: "files/content.png",
        mimeType: "image/png",
        bytes: blob.size,
        sha256: await sha256Blob(blob),
    };

    await verifyRestoreMediaBlob(plan, blob);
    await assert.rejects(verifyRestoreMediaBlob(plan, new Blob(["other"])), /恢复媒体校验失败/);
});

test("restore journal parsing rejects unknown fields and inconsistent deletion targets", async () => {
    const ids = ["m".repeat(21), "p".repeat(21), "a".repeat(21), "i".repeat(21), "v".repeat(21), "j".repeat(21)];
    const journal = await prepareAppRestoreJournal(backupManifest(), {
        idFactory: () => ids.shift() || "x".repeat(21),
        now: timestamp,
        reservedIds: [],
        storageKeyExists: async () => false,
    });
    assert.equal(parseAppRestoreJournal(journal).id, "j".repeat(21));

    assert.throws(() => parseAppRestoreJournal({ ...journal, extra: true }), /字段/);
    assert.throws(() => parseAppRestoreJournal({ ...journal, media: [{ ...journal.media[0], targetKey: "image:existing-local-key" }] }), /目标媒体键/);
    assert.throws(() => parseAppRestoreJournal({ ...journal, phase: "committing" }), /阶段与媒体进度/);
});

test("restore journal removal accepts an error after deletion already committed", async () => {
    let value: unknown = { active: true };
    await removeVerifiedRestoreJournal(
        async () => {
            value = null;
            throw new Error("late storage error");
        },
        async () => value,
    );

    value = { active: true };
    await assert.rejects(
        removeVerifiedRestoreJournal(
            async () => {
                throw new Error("remove failed");
            },
            async () => value,
        ),
        /remove failed/,
    );
});
