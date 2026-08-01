import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, saveConfig, type CanvasAgentConfig } from "./config.js";

function temporaryConfig(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-config-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, file: path.join(directory, "settings", "canvas-agent.json") };
}

function strongToken() {
    return crypto.randomBytes(18).toString("hex");
}

function validConfig(workspacePath: string): CanvasAgentConfig {
    return {
        url: "http://127.0.0.1:17371",
        token: strongToken(),
        origins: ["https://canvas.best", "http://localhost:3000"],
        workspace: { workspacePath, activeThreadId: "thread-1", pinnedThreadIds: ["thread-1"] },
    };
}

test("saveConfig writes a strict configuration atomically with private POSIX modes", (t) => {
    const { directory, file } = temporaryConfig(t);
    const workspacePath = path.join(directory, "workspace");
    saveConfig(validConfig(workspacePath), file);

    assert.deepEqual(loadConfig(false, file), validConfigFromFile(file));
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
    if (process.platform !== "win32") {
        assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
});

test("loadConfig rotates a weak token while preserving valid workspace and origins", (t) => {
    const { directory, file } = temporaryConfig(t);
    const workspacePath = path.join(directory, "workspace");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...validConfig(workspacePath), token: "weak-token" }));

    const loaded = loadConfig(true, file);
    assert.match(loaded.token, /^[0-9a-f]{36}$/);
    assert.notEqual(loaded.token, "weak-token");
    assert.deepEqual(loaded.origins, ["https://canvas.best", "http://localhost:3000"]);
    assert.equal(loaded.workspace?.workspacePath, workspacePath);
    assert.equal(validConfigFromFile(file).token, loaded.token);
});

test("loadConfig rejects unknown fields and non-loopback service URLs", (t) => {
    const { directory, file } = temporaryConfig(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...validConfig(path.join(directory, "workspace")), url: "https://example.com", extra: true }));

    const loaded = loadConfig(false, file);
    assert.equal(loaded.url, "http://127.0.0.1:17371");
    assert.match(loaded.token, /^[0-9a-f]{36}$/);
    assert.equal(loaded.workspace, undefined);
});

test("loadConfig preserves a corrupt file before creating a replacement", (t) => {
    const { file } = temporaryConfig(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const corruptContents = "{not-json";
    fs.writeFileSync(file, corruptContents);

    const loaded = loadConfig(true, file);
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.corrupt-`));

    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8"), corruptContents);
    assert.deepEqual(validConfigFromFile(file), loaded);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(path.dirname(file), backups[0])).mode & 0o777, 0o600);
});

test("saveConfig refuses weak tokens instead of persisting them", (t) => {
    const { directory, file } = temporaryConfig(t);
    assert.throws(() => saveConfig({ ...validConfig(path.join(directory, "workspace")), token: "short" }, file), /too weak/);
    assert.equal(fs.existsSync(file), false);
});

function validConfigFromFile(file: string) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CanvasAgentConfig;
}
