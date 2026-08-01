import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeAttachmentFiles } from "./attachment-files.js";

test("Codex attachment files are private and excluded from Git staging", async (t) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "canvas-agent-attachments-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const initialized = spawnSync("git", ["init", "--quiet", workspace], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const [file] = await writeAttachmentFiles(
    [
      {
        name: "private.png",
        type: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ],
    workspace,
  );
  assert.equal(fs.existsSync(file), true);
  assert.equal(
    spawnSync("git", ["-C", workspace, "check-ignore", "--quiet", file], {
      windowsHide: true,
    }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["-C", workspace, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(),
    "",
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});
