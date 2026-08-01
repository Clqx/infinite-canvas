import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentAttachment } from "./types.js";

const ATTACHMENT_DIRECTORY = path.join(".infinite-canvas-agent", "attachments");

export async function writeAttachmentFiles(
  attachments: AgentAttachment[],
  workspacePath?: string,
) {
  const images = attachments.filter((item) =>
    item.dataUrl?.startsWith("data:image/"),
  );
  if (!images.length) return [];
  if (!workspacePath) throw new Error("图片附件缺少允许的工作空间");
  const directory = path.join(workspacePath, ATTACHMENT_DIRECTORY);
  await ensureGitExcluded(workspacePath, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  const files: string[] = [];
  try {
    for (const item of images)
      files.push(await writeAttachmentFile(item, directory));
    return files;
  } catch (error) {
    await Promise.all(
      files.map((file) => fs.unlink(file).catch(() => undefined)),
    );
    throw error;
  }
}

async function writeAttachmentFile(item: AgentAttachment, directory: string) {
  const [, meta = "", data = ""] =
    item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
  if (!data) throw new Error(`图片附件无效：${item.name || "未命名图片"}`);
  const file = path.join(
    directory,
    `${crypto.randomUUID()}.${imageExt(meta || item.type)}`,
  );
  await fs.writeFile(file, Buffer.from(data, "base64"), {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
  return file;
}

async function ensureGitExcluded(
  workspacePath: string,
  attachmentDirectory: string,
) {
  const repositoryRoot = gitPath(workspacePath, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (!repositoryRoot) return;
  const excludeOutput = gitPath(
    workspacePath,
    ["rev-parse", "--git-path", "info/exclude"],
    true,
  );
  const excludeFile = path.isAbsolute(excludeOutput)
    ? excludeOutput
    : path.resolve(workspacePath, excludeOutput);
  const relativeDirectory = path
    .relative(repositoryRoot, attachmentDirectory)
    .split(path.sep)
    .join("/");
  if (!relativeDirectory || relativeDirectory.startsWith("../"))
    throw new Error("无法保护图片附件目录");
  const rule = `/${relativeDirectory}/`;
  let current = "";
  try {
    current = await fs.readFile(excludeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.split(/\r?\n/).includes(rule)) return;
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  const temporary = `${excludeFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    await fs.writeFile(temporary, `${current}${separator}${rule}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, excludeFile);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function gitPath(cwd: string, args: string[], required = false) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = result.status === 0 ? result.stdout.trim() : "";
  if (required && !output) throw new Error("无法配置 Git 图片附件排除规则");
  return output;
}

function imageExt(type = "") {
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  return "jpg";
}
