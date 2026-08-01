import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sanitizeBootstrapUrl } from "./bootstrap-secrets";

describe("sanitizeBootstrapUrl", () => {
    test("captures fragment credentials and removes them from the visible URL", () => {
        const result = sanitizeBootstrapUrl("https://canvas.test/canvas/1?mode=new#agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=secret&view=chat");
        assert.deepEqual(result.agent, { url: "http://127.0.0.1:17371", token: "secret" });
        assert.equal(result.relativeUrl, "/canvas/1?mode=new#view=chat");
    });

    test("deletes legacy query credentials without importing them", () => {
        const result = sanitizeBootstrapUrl("https://canvas.test/?apiKey=sk-secret&agentToken=secret&agentUrl=http://localhost:17371&baseUrl=https://api.test");
        assert.equal(result.agent, null);
        assert.equal(result.removedLegacySecrets, true);
        assert.equal(result.relativeUrl, "/");
    });

    test("rejects non-loopback Agent bootstrap endpoints", () => {
        const result = sanitizeBootstrapUrl("https://canvas.test/canvas#agentUrl=https%3A%2F%2Fevil.example&agentToken=secret");
        assert.equal(result.agent, null);
        assert.equal(result.removedLegacySecrets, true);
        assert.equal(result.relativeUrl, "/canvas");
    });

    test("preserves ordinary anchors", () => {
        const result = sanitizeBootstrapUrl("https://canvas.test/docs#security");
        assert.equal(result.changed, false);
        assert.equal(result.relativeUrl, "/docs#security");
    });
});
