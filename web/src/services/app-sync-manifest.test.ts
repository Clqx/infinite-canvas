import assert from "node:assert/strict";
import { test } from "node:test";

import { createDomainManifest, parseDomainManifest } from "./app-sync-manifest";

const sha = "a".repeat(64);
const file = { storageKey: "image:key", path: "canvas/files/a.png", mimeType: "image/png", bytes: 12, sha256: sha };

function manifest(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({ app: "infinite-canvas", version: 2, domain: "canvas", exportedAt: "2026-08-02T00:00:00.000Z", data: { projects: [] }, files: [file], ...overrides });
}

test("manifest v2 parses strict fields and SHA-256 entries", () => {
    const parsed = parseDomainManifest(manifest(), "canvas", (value) => value as { projects: unknown[] });

    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.files, [file]);
});

test("manifest parsing rejects future versions, unknown fields, and invalid timestamps", () => {
    assert.throws(() => parseDomainManifest(manifest({ version: 3 }), "canvas", (value) => value), /version|版本/);
    assert.throws(() => parseDomainManifest(manifest({ extra: true }), "canvas", (value) => value), /fields/);
    assert.throws(() => parseDomainManifest(manifest({ exportedAt: "invalid" }), "canvas", (value) => value), /exportedAt/);
});

test("manifest parsing rejects duplicate keys and unsafe paths before returning data", () => {
    assert.throws(() => parseDomainManifest(manifest({ files: [file, { ...file, path: "canvas/files/b.png" }] }), "canvas", (value) => value), /重复 storageKey/);
    assert.throws(() => parseDomainManifest(manifest({ files: [{ ...file, path: "canvas/files/../secret" }] }), "canvas", (value) => value), /非法文件路径/);
    assert.throws(() => parseDomainManifest(manifest({ files: [{ ...file, sha256: "bad" }] }), "canvas", (value) => value), /SHA-256/);
});

test("manifest v1 remains readable only with its exact legacy file fields", () => {
    const legacyFile = { storageKey: file.storageKey, path: file.path, mimeType: file.mimeType, bytes: file.bytes };
    const parsed = parseDomainManifest(manifest({ version: 1, files: [legacyFile] }), "canvas", (value, version) => ({ value, version }));

    assert.equal(parsed.version, 1);
    assert.equal(parsed.files[0].sha256, undefined);
});

test("new manifests require every file to have a digest", () => {
    assert.throws(() => createDomainManifest("canvas", { projects: [] }, [{ ...file, sha256: undefined }]), /SHA-256/);
});

test("different storage keys may reuse one identical content-addressed path", () => {
    const sha256 = "a".repeat(64);
    const manifest = createDomainManifest("canvas", { projects: [], projectTombstones: [] }, [
        { storageKey: "image:first", path: `canvas/files/${sha256}.png`, mimeType: "image/png", bytes: 5, sha256 },
        { storageKey: "image:second", path: `canvas/files/${sha256}.png`, mimeType: "image/png", bytes: 5, sha256 },
    ]);

    assert.equal(parseDomainManifest(JSON.stringify(manifest), "canvas", (value) => value).files.length, 2);
    assert.throws(
        () =>
            createDomainManifest("canvas", { projects: [], projectTombstones: [] }, [
                { storageKey: "image:first", path: `canvas/files/${sha256}.png`, mimeType: "image/png", bytes: 5, sha256 },
                { storageKey: "image:second", path: `canvas/files/${sha256}.png`, mimeType: "application/octet-stream", bytes: 5, sha256 },
            ]),
        /路径对应多个文件描述/,
    );
});
