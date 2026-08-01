import assert from "node:assert/strict";
import { test } from "node:test";

import { isSha256, sha256Blob } from "./content-digest";

test("blob SHA-256 is calculated incrementally and validated", async () => {
    const digest = await sha256Blob(new Blob(["infinite-canvas"]));

    assert.equal(digest, "2f13fe7913974bd57a5899677436a50b7b2e067270e57fc6232c73f671868e78");
    assert.equal(isSha256(digest), true);
    assert.equal(isSha256(digest.toUpperCase()), false);
});
