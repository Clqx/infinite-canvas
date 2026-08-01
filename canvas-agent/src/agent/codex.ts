import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { errorMessage, field } from "../utils/value.js";
import { CodexAppClient } from "./codex-client.js";
import { summarizeCodexThread, threadMessages } from "./codex-history.js";
import type { CodexReasoningEffort } from "./codex-protocol.js";
import type {
  AgentAttachment,
  AgentEmit,
  AgentPermissionMode,
} from "./types.js";
import { writeAttachmentFiles } from "./attachment-files.js";

type CodexRunOptions = {
  threadId?: string;
  cwd?: string;
  permissionMode?: AgentPermissionMode;
  model?: string;
  effort?: CodexReasoningEffort;
  appEmit?: AgentEmit;
  onStart?: () => void;
  onThread?: (threadId: string) => void;
  onTurn?: (turnId: string) => void;
  onFinish?: () => void;
};

let codexQueue: Promise<unknown> = Promise.resolve();
let codexApp: CodexAppClient | null = null;
let codexAppStart: Promise<CodexAppClient> | null = null;
let codexThreadId = "";
const unmaterializedThreadIds = new Set<string>();

export { summarizeCodexThread } from "./codex-history.js";

/** 将 Codex turn 加入串行队列并等待执行完成。 */
export async function runCodexTurn(
  prompt: string,
  emit: AgentEmit,
  attachments: AgentAttachment[] = [],
  options: CodexRunOptions = {},
) {
  if (!prompt.trim()) return;
  codexQueue = codexQueue
    .catch(() => undefined)
    .then(() => runCodexTurnNow(prompt, emit, attachments, options));
  await codexQueue;
}

/** 中断当前线程正在执行的 Codex turn。 */
export async function interruptCodexTurn(threadId?: string) {
  if (!codexApp || (threadId && threadId !== codexThreadId)) return false;
  return await codexApp.interruptCurrentTurn();
}

/** 回复当前 app-server 的待处理权限请求。 */
export async function resolveCodexApproval(
  requestId: string,
  decision: string,
) {
  return Boolean(codexApp?.resolveApproval(requestId, decision));
}

/** 创建新的 Codex 线程并记录当前线程 ID。 */
export async function startCodexThread(
  emit: AgentEmit,
  cwd?: string,
  permissionMode: AgentPermissionMode = "request",
) {
  const app = await getCodexApp(emit);
  const thread = await app.startThread(cwd, permissionMode);
  codexThreadId = String(field(thread, "id") || "");
  if (codexThreadId) unmaterializedThreadIds.add(codexThreadId);
  return thread;
}

/** 恢复指定 Codex 线程并返回聊天历史。 */
export async function resumeCodexThread(
  emit: AgentEmit,
  threadId: string,
  cwd?: string,
  permissionMode: AgentPermissionMode = "request",
) {
  const app = await getCodexApp(emit);
  await loadCodexThread(emit, threadId, cwd, false);
  const thread = await app.resumeThread(threadId, cwd, permissionMode);
  assertThreadWorkspace(thread, cwd);
  codexThreadId = String(field(thread, "id") || threadId);
  const historyThread = await loadCodexThread(emit, codexThreadId, cwd, true);
  return {
    thread,
    messages: threadMessages(historyThread, app.planUpdates(threadId)),
  };
}

/** 查询当前工作空间中的 Codex 线程。 */
export async function listCodexThreads(
  emit: AgentEmit,
  options: { cwd: string; searchTerm?: string; limit?: number },
) {
  const app = await getCodexApp(emit);
  const result = await app.listThreads({
    limit: options.limit || 40,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: ["cli", "vscode", "appServer", "exec"],
    cwd: options.cwd,
    ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
  });
  const data = Array.isArray(field(result, "data"))
    ? (field(result, "data") as unknown[])
        .map(summarizeCodexThread)
        .filter((thread) => threadInWorkspace(thread, options.cwd))
    : [];
  return {
    data,
    nextCursor: field(result, "nextCursor") || null,
    backwardsCursor: field(result, "backwardsCursor") || null,
  };
}

/** 查询当前账号可用于新任务的 Codex 模型。 */
export async function listCodexModels(emit: AgentEmit) {
  return await (await getCodexApp(emit)).listModels();
}

/** 读取指定 Codex 线程及其聊天历史。 */
export async function readCodexThread(
  emit: AgentEmit,
  threadId: string,
  cwd?: string,
) {
  const app = await getCodexApp(emit);
  let thread: unknown;
  try {
    thread = await loadCodexThread(
      emit,
      threadId,
      cwd,
      !unmaterializedThreadIds.has(threadId),
    );
  } catch (error) {
    if (!/not materialized yet.*includeTurns/i.test(errorMessage(error)))
      throw error;
    unmaterializedThreadIds.add(threadId);
    thread = await loadCodexThread(emit, threadId, cwd, false);
  }
  return {
    thread: summarizeCodexThread(thread),
    messages: threadMessages(thread, app.planUpdates(threadId)),
  };
}

/** 确认指定 Codex 线程属于当前工作空间。 */
export async function verifyCodexThreadWorkspace(
  emit: AgentEmit,
  threadId: string,
  cwd: string,
) {
  await loadCodexThread(emit, threadId, cwd, false);
}

/** 归档指定 Codex 线程。 */
export async function archiveCodexThread(
  emit: AgentEmit,
  threadId: string,
  cwd?: string,
) {
  const app = await getCodexApp(emit);
  await loadCodexThread(emit, threadId, cwd, false);
  await app.archiveThread(threadId);
  app.clearPlanUpdates(threadId);
  unmaterializedThreadIds.delete(threadId);
}

/** 判断线程异常是否允许自动新建线程后重试。 */
export function isRecoverableThreadError(error: unknown) {
  return /thread not loaded|no rollout found/i.test(errorMessage(error));
}

/** 执行一次 Codex turn，并负责附件临时文件和线程恢复。 */
async function runCodexTurnNow(
  prompt: string,
  emit: AgentEmit,
  attachments: AgentAttachment[],
  options: CodexRunOptions,
) {
  let files: string[] = [];
  try {
    options.onStart?.();
    files = await writeAttachmentFiles(attachments, options.cwd);
    const app = await getCodexApp(options.appEmit || emit);
    let threadId = await ensureCodexThread(app, options, emit);
    options.onThread?.(threadId);
    unmaterializedThreadIds.delete(threadId);
    try {
      await app.startTurn(
        threadId,
        prompt,
        files,
        options.permissionMode || "request",
        options.model,
        options.effort,
        options.onTurn,
      );
    } catch (error) {
      if (!isRecoverableThreadError(error)) throw error;
      emit("agent_log", {
        text: `Codex thread unavailable, starting a new thread: ${errorMessage(error)}`,
      });
      codexThreadId = "";
      threadId = await ensureCodexThread(app, { cwd: options.cwd }, emit);
      options.onThread?.(threadId);
      unmaterializedThreadIds.delete(threadId);
      await app.startTurn(
        threadId,
        prompt,
        files,
        options.permissionMode || "request",
        options.model,
        options.effort,
        options.onTurn,
      );
    }
  } catch (error) {
    logger.error("Codex turn failed", error);
    emit("agent_error", { message: errorMessage(error) });
  } finally {
    options.onFinish?.();
    await Promise.all(
      files.map((file) => fs.unlink(file).catch(() => undefined)),
    );
  }
}

/** 恢复请求线程或创建新的 Codex 线程。 */
async function ensureCodexThread(
  app: CodexAppClient,
  options: CodexRunOptions,
  emit: AgentEmit,
) {
  if (options.threadId) {
    if (options.threadId === codexThreadId) return codexThreadId;
    try {
      const result = await app.readThread(options.threadId, false);
      assertThreadWorkspace(field(result, "thread") || {}, options.cwd);
      const thread = await app.resumeThread(
        options.threadId,
        options.cwd,
        options.permissionMode || "request",
      );
      assertThreadWorkspace(thread, options.cwd);
      codexThreadId = String(field(thread, "id") || options.threadId);
      return codexThreadId;
    } catch (error) {
      if (!isRecoverableThreadError(error)) throw error;
      emit("agent_log", {
        text: `Codex thread unavailable, starting a new thread: ${errorMessage(error)}`,
      });
    }
  }
  if (!codexThreadId) {
    const thread = await app.startThread(
      options.cwd,
      options.permissionMode || "request",
    );
    codexThreadId = String(field(thread, "id") || "");
    if (codexThreadId) unmaterializedThreadIds.add(codexThreadId);
  }
  return codexThreadId;
}

/** 从 app-server 读取线程并校验工作空间。 */
async function loadCodexThread(
  emit: AgentEmit,
  threadId: string,
  cwd: string | undefined,
  includeTurns: boolean,
) {
  const app = await getCodexApp(emit);
  const result = await app.readThread(threadId, includeTurns);
  const thread = field(result, "thread") || {};
  assertThreadWorkspace(thread, cwd);
  return thread;
}

/** 获取已启动的 Codex app-server 客户端。 */
async function getCodexApp(emit: AgentEmit) {
  if (codexApp) return codexApp;
  codexAppStart ||= CodexAppClient.start(emit, () => {
    codexApp = null;
    codexThreadId = "";
  });
  try {
    codexApp = await codexAppStart;
    return codexApp;
  } finally {
    codexAppStart = null;
  }
}

/** 校验线程是否属于指定工作空间。 */
function assertThreadWorkspace(thread: unknown, cwd?: string) {
  if (!cwd || threadInWorkspace(thread, cwd)) return;
  throw new Error("该 Codex 会话不属于当前画布工作空间");
}

/** 判断线程工作目录是否与当前工作空间一致。 */
function threadInWorkspace(thread: unknown, cwd: string) {
  const threadCwd = String(field(thread, "cwd") || "");
  return Boolean(threadCwd && path.resolve(threadCwd) === path.resolve(cwd));
}
