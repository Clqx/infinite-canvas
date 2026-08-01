import assert from "node:assert/strict";
import test from "node:test";

import {
    clearLegacyCredentialStorage,
    createCredentialExport,
    createDefaultCredentialPayload,
    MAX_CREDENTIAL_BACKUP_BYTES,
    openCredentialExport,
    readCredentialExportFile,
    readLegacyCredentialPayload,
    type LegacyCredentialStorage,
} from "./credential-vault";
import { CONFIG_STORE_KEY } from "@/stores/use-config-store";
import { PROMPT_SOURCE_STORE_KEY } from "@/stores/use-prompt-source-store";

function memoryStorage(initial: Record<string, string>) {
    const values = new Map(Object.entries(initial));
    const storage: LegacyCredentialStorage = {
        getItem: (key) => values.get(key) ?? null,
        removeItem: (key) => void values.delete(key),
    };
    return { values, storage };
}

test("legacy credential migration reads supported stores through an injected adapter", () => {
    const { storage } = memoryStorage({
        [CONFIG_STORE_KEY]: JSON.stringify({ state: { config: { apiKey: "legacy-key" }, webdav: { username: "legacy-user", password: "legacy-password" } } }),
        [PROMPT_SOURCE_STORE_KEY]: JSON.stringify({ state: { sources: [], schedule: { intervalMinutes: 60, lastFetchedAt: "" } } }),
        "canvas-agent-url": "http://127.0.0.1:17372",
        "canvas-agent-token": "legacy-agent-token",
    });

    const result = readLegacyCredentialPayload(storage);

    assert.equal(result.found, true);
    assert.equal(result.payload.config.apiKey, "legacy-key");
    assert.equal(result.payload.webdav.username, "legacy-user");
    assert.equal(result.payload.webdav.password, "legacy-password");
    assert.deepEqual(result.payload.agentConnection, { url: "http://127.0.0.1:17372", token: "legacy-agent-token" });
    assert.equal(result.payload.promptSources.schedule.intervalMinutes, 60);
});

test("legacy cleanup removes only credential keys", () => {
    const { values, storage } = memoryStorage({
        [CONFIG_STORE_KEY]: "config",
        [PROMPT_SOURCE_STORE_KEY]: "prompts",
        "canvas-agent-url": "url",
        "canvas-agent-token": "token",
        "infinite-canvas:canvas-data": "keep",
    });

    clearLegacyCredentialStorage(storage);

    assert.deepEqual([...values.entries()], [["infinite-canvas:canvas-data", "keep"]]);
});

test("legacy cleanup remains best effort after a verified encrypted migration", () => {
    const attempted: string[] = [];
    clearLegacyCredentialStorage({
        getItem: () => null,
        removeItem: (key) => {
            attempted.push(key);
            if (key === CONFIG_STORE_KEY) throw new Error("blocked");
        },
    });
    assert.equal(attempted.length, 4);
});

test("credential export round-trips strict payloads and rejects authenticated malformed data", async () => {
    const payload = createDefaultCredentialPayload();
    payload.config.apiKey = "test-key";
    const encrypted = await createCredentialExport("Backup-password-2026!", payload);
    assert.deepEqual(await openCredentialExport("Backup-password-2026!", encrypted), payload);

    const malformed = createDefaultCredentialPayload() as unknown as Record<string, any>;
    (malformed.webdav as Record<string, unknown>).url = 42;
    const malformedEncrypted = await createCredentialExport("Backup-password-2026!", malformed as never);
    await assert.rejects(() => openCredentialExport("Backup-password-2026!", malformedEncrypted), { code: "DECRYPTION_FAILED" });
});

test("credential backup files are rejected before reading oversized contents", async () => {
    let read = false;
    const file = { size: MAX_CREDENTIAL_BACKUP_BYTES + 1, text: async () => ((read = true), "") } as File;
    await assert.rejects(() => readCredentialExportFile(file), /不能超过 6MB/);
    assert.equal(read, false);
});
