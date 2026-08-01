import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";

import { createZip, readZip } from "./zip";

test("streaming ZIP read returns validated files", async () => {
    const archive = await createZip([
        { name: "backup.json", data: "{}" },
        { name: "files/item.txt", data: "content" },
    ]);
    const files = await readZip(archive);

    assert.deepEqual([...files.keys()], ["backup.json", "files/item.txt"]);
    assert.equal(await files.get("files/item.txt")?.text(), "content");
});

test("ZIP read rejects compressed, expanded, ratio, and path limits before returning files", async () => {
    const compressed = new Blob([zipSync({ "large.txt": new TextEncoder().encode("a".repeat(64 * 1024)) }, { level: 9 })]);
    const unsafePath = new Blob([zipSync({ "../outside.txt": new Uint8Array([1]) }, { level: 0 })]);

    await assert.rejects(readZip(compressed, { maxCompressionRatio: 2 }), /压缩比/);
    await assert.rejects(readZip(compressed, { maxExpandedBytes: 1024 }), /总展开大小/);
    await assert.rejects(readZip(compressed, { maxCompressedBytes: 1 }), /压缩大小/);
    await assert.rejects(readZip(unsafePath), /非法或重复路径/);
});
