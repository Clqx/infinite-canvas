import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWorkspacePath, WorkspacePathError } from "./path-security.js";

test("resolveWorkspacePath accepts existing files inside the workspace", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-path-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, "nested");
    const file = path.join(nested, "image.png");
    fs.mkdirSync(nested);
    fs.writeFileSync(file, "image");

    assert.equal(await resolveWorkspacePath(root, file), fs.realpathSync(file));
});

test("resolveWorkspacePath rejects relative paths and traversal outside the workspace", async (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-path-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside.png");
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "image");

    await assert.rejects(resolveWorkspacePath(root, "outside.png"), WorkspacePathError);
    await assert.rejects(resolveWorkspacePath(root, path.join(root, "..", "outside.png")), WorkspacePathError);
});

test("resolveWorkspacePath rejects symlinks that escape the workspace", async (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-path-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, "workspace");
    const outsideDirectory = path.join(parent, "outside");
    const outside = path.join(outsideDirectory, "outside.png");
    const link = path.join(root, "linked");
    fs.mkdirSync(outsideDirectory);
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "image");
    try {
        fs.symlinkSync(outsideDirectory, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        t.skip(`symlink creation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    await assert.rejects(resolveWorkspacePath(root, path.join(link, "outside.png")), WorkspacePathError);
});
