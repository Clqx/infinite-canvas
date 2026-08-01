import assert from "node:assert/strict";
import test from "node:test";

import { parseAppConfig } from "./config-file";
import { defaultConfig, defaultWebdavSyncConfig } from "@/stores/use-config-store";
import { defaultPromptSourceSchedule } from "@/stores/use-prompt-source-store";

function configFile(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        app: "infinite-canvas",
        version: 2,
        exportedAt: "2026-08-01T00:00:00.000Z",
        includesSecrets: false,
        config: defaultConfig,
        webdav: defaultWebdavSyncConfig,
        promptSources: { sources: [], schedule: defaultPromptSourceSchedule },
        ...overrides,
    });
}

test("strict config import accepts a secret-free version 2 export", () => {
    const result = parseAppConfig(configFile());
    assert.equal(result.data.version, 2);
    assert.equal(result.hasPlaintextSensitiveData, false);
});

test("strict config import detects plaintext credentials even when metadata denies them", () => {
    const result = parseAppConfig(
        configFile({
            config: { ...defaultConfig, apiKey: "sk-plaintext", channels: [{ ...defaultConfig.channels[0], apiKey: "channel-secret" }] },
            webdav: { ...defaultWebdavSyncConfig, username: "user", password: "password" },
        }),
    );
    assert.equal(result.hasPlaintextSensitiveData, true);
});

test("strict config import rejects unknown fields and malformed nested values", () => {
    assert.throws(() => parseAppConfig(configFile({ unexpected: true })), /格式不正确/);
    assert.throws(() => parseAppConfig(configFile({ config: { ...defaultConfig, channels: [null] } })), /格式不正确/);
    assert.throws(() => parseAppConfig(configFile({ promptSources: { sources: [{ id: "x", name: "x", url: "", homepage: "", enabled: true, builtIn: false, extra: true }], schedule: defaultPromptSourceSchedule } })), /格式不正确/);
});
