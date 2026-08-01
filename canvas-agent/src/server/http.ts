import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { runClaudeTurn } from "../agent/claude.js";
import {
  archiveCodexThread,
  interruptCodexTurn,
  isRecoverableThreadError,
  listCodexModels,
  listCodexThreads,
  readCodexThread,
  resolveCodexApproval,
  resumeCodexThread,
  runCodexTurn,
  startCodexThread,
  summarizeCodexThread,
  verifyCodexThreadWorkspace,
} from "../agent/codex.js";
import type { CodexReasoningEffort } from "../agent/codex-protocol.js";
import type { AgentAttachment, AgentPermissionMode } from "../agent/types.js";
import { CanvasSession } from "../canvas/session.js";
import {
  CONFIG_FILE,
  DEFAULT_PORT,
  ensureSiteWorkspace,
  loadConfig,
  saveConfig,
  updateSiteWorkspace,
  type CanvasAgentConfig,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { checkVersions } from "../version-check.js";
import { resolveWorkspacePath, WorkspacePathError } from "./path-security.js";

type HttpAppOptions = { configFile?: string; session?: CanvasSession };
const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

/** 启动仅监听本机的 Canvas Agent HTTP 服务。 */
export function startHttpServer() {
  const config = loadConfig(true);
  const requestedPort =
    Number(process.env.PORT) ||
    Number(new URL(config.url).port) ||
    DEFAULT_PORT;
  const port =
    Number.isInteger(requestedPort) &&
    requestedPort > 0 &&
    requestedPort <= 65535
      ? requestedPort
      : DEFAULT_PORT;
  config.url = `http://127.0.0.1:${port}`;
  saveConfig(config);

  const app = createHttpApp(config);
  return app.listen(port, "127.0.0.1", () => {
    console.log("Infinite Canvas Agent");
    checkVersions();
    console.log(`Local URL: ${config.url}`);
    console.log(`Connect token: ${config.token}`);
    console.log("Codex MCP is not installed by this command.");
    console.log(
      "Optional MCP add: codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent mcp",
    );
    console.log("Remove manually added MCP: codex mcp remove infinite-canvas");
    if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
    logger.info("Canvas Agent started", {
      url: config.url,
      workspace: ensureSiteWorkspace(config).workspacePath,
      debugLog: logger.filePath,
    });
  });
}

/** 创建 Canvas Agent HTTP 应用，供本地服务和集成测试共用。 */
export function createHttpApp(
  config: CanvasAgentConfig,
  options: HttpAppOptions = {},
) {
  const configFile = options.configFile || CONFIG_FILE;
  const session = options.session || new CanvasSession();
  /** 将 Agent 事件广播到所属线程或全部网页。 */
  const emit = (type: string, payload: unknown) => {
    const data =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : { value: payload };
    const threadId = String(
      data.threadId ||
        data.thread_id ||
        ensureSiteWorkspace(config, configFile).activeThreadId ||
        "",
    );
    threadId
      ? session.emitThread(type, threadId, data)
      : session.emitAll(type, data);
  };
  /** 保存并广播当前站点工作空间的活跃线程。 */
  const setActiveThread = (
    activeThreadId: string,
    payload: Record<string, unknown> = {},
  ) => {
    const workspace = updateSiteWorkspace(
      config,
      { activeThreadId: activeThreadId || undefined },
      configFile,
    );
    session.emitThread("workspace_changed", activeThreadId, {
      ...payload,
      activeThreadId,
    });
    return workspace;
  };
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use((req, res, next) => {
    if (!logger.enabled) return next();
    const startedAt = Date.now();
    const url = requestUrl(req, config);
    res.on("finish", () => {
      if (
        req.method === "OPTIONS" ||
        (res.statusCode < 400 &&
          ["/health", "/canvas/state", "/canvas/activate"].includes(
            url.pathname,
          ))
      )
        return;
      logger.debug(`HTTP ${req.method} ${url.pathname}`, {
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });
  app.use((req, res, next) => {
    const url = requestUrl(req, config);
    if (!setCors(req, res, url, config, configFile))
      return void res
        .status(403)
        .json({ ok: false, error: "origin not allowed" });
    if (url.searchParams.has("token"))
      return void res.status(401).json({ ok: false, error: "invalid token" });
    if (req.method === "OPTIONS") return void res.json({});
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/config", (_req, res) =>
    res.json({ ok: true, url: config.url, hasToken: true }),
  );
  app.use((req, res, next) => {
    if (validToken(req, config.token)) return next();
    res.status(401).json({ ok: false, error: "invalid token" });
  });
  app.use(express.json({ limit: "30mb" }));
  app.get("/events", (req, res) =>
    session.openEvents(requestUrl(req, config), res),
  );
  app.post("/canvas/state", (req, res) => {
    session.updateState(
      req.body,
      String(req.query.clientId || "") || undefined,
    );
    res.json({ ok: true });
  });
  app.post("/canvas/activate", (req, res) => {
    session.activateClient(String(req.query.clientId || ""));
    res.json({ ok: true });
  });
  app.post("/canvas/result", (req, res) => {
    const ok = session.resolveResult(
      String(req.query.clientId || ""),
      req.body,
    );
    res.status(ok ? 200 : 409).json({ ok });
  });
  app.get(
    "/agent/attachments/:attachmentId",
    route(async (req, res) => {
      const attachment = session.getTurnAttachment(
        String(req.query.clientId || ""),
        routeParam(req.params.attachmentId),
      );
      const data = attachment.dataUrl.split(",", 2)[1];
      if (!data) throw new Error("图片附件内容无效");
      res.setHeader("Cache-Control", "no-store");
      res.type(attachment.type).send(Buffer.from(data, "base64"));
    }),
  );
  app.post(
    "/agent/local-file/reveal",
    route(async (req, res) => {
      const filePath = await resolveWorkspacePath(
        ensureSiteWorkspace(config, configFile).workspacePath,
        String(req.body?.path || ""),
      );
      const file = await stat(filePath);
      await revealLocalFile(filePath, file.isDirectory());
      res.json({ ok: true });
    }),
  );
  app.post(
    "/agent/local-image",
    route(async (req, res) => {
      const requestedPath = String(req.body?.path || "");
      if (!/\.(?:avif|gif|jpe?g|png|webp)$/i.test(requestedPath))
        return res.status(400).json({ ok: false, error: "图片路径无效" });
      const filePath = await resolveWorkspacePath(
        ensureSiteWorkspace(config, configFile).workspacePath,
        requestedPath,
      );
      const file = await open(filePath, "r");
      try {
        const metadata = await file.stat();
        if (!metadata.isFile())
          return res.status(400).json({ ok: false, error: "图片文件无效" });
        if (metadata.size > MAX_LOCAL_IMAGE_BYTES)
          return res
            .status(413)
            .json({ ok: false, error: "图片文件不能超过 25MB" });
        const header = Buffer.alloc(32);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        const mimeType = detectImageMime(header.subarray(0, bytesRead));
        if (!mimeType)
          return res.status(400).json({ ok: false, error: "图片文件无效" });
        res.setHeader("Cache-Control", "no-store");
        res.type(mimeType).send(await file.readFile());
      } finally {
        await file.close();
      }
    }),
  );
  app.post(
    "/api/tools",
    route(async (req, res) =>
      res.json({
        ok: true,
        result: await session.callTool(req.body?.name, req.body?.input || {}),
      }),
    ),
  );
  app.get("/agent/codex/workspace", (_req, res) => {
    const workspace = ensureSiteWorkspace(config, configFile);
    res.json({ ok: true, workspace });
  });
  app.get(
    "/agent/codex/models",
    route(async (_req, res) =>
      res.json({ ok: true, ...(await listCodexModels(emit)) }),
    ),
  );
  app.get(
    "/agent/codex/threads",
    route(async (req, res) => {
      const workspace = ensureSiteWorkspace(config, configFile);
      const result = await listCodexThreads(emit, {
        cwd: workspace.workspacePath,
        searchTerm: String(req.query.searchTerm || ""),
      });
      res.json({ ok: true, workspace, ...result });
    }),
  );
  app.post(
    "/agent/codex/threads/new",
    route(async (req, res) => {
      if (session.codexBusy)
        return res
          .status(409)
          .json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
      const workspace = ensureSiteWorkspace(config, configFile);
      const thread = await startCodexThread(
        emit,
        workspace.workspacePath,
        permissionMode(req.body?.permissionMode),
      );
      const activeThreadId = String(
        (thread as Record<string, unknown>).id || "",
      );
      const nextWorkspace = setActiveThread(activeThreadId, {
        emptyThread: true,
      });
      res.json({
        ok: true,
        workspace: nextWorkspace,
        thread: summarizeCodexThread(thread),
        messages: [],
      });
    }),
  );
  app.post("/agent/codex/threads/reset", (req, res) => {
    if (session.codexBusy)
      return res
        .status(409)
        .json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
    res.json({
      ok: true,
      workspace: setActiveThread("", { emptyThread: true, draftThread: true }),
    });
  });
  app.get(
    "/agent/codex/threads/:threadId",
    route(async (req, res) => {
      const workspace = ensureSiteWorkspace(config, configFile);
      const threadId = routeParam(req.params.threadId);
      try {
        res.json({
          ok: true,
          workspace,
          ...(await readCodexThread(emit, threadId, workspace.workspacePath)),
        });
      } catch (error) {
        if (
          workspace.activeThreadId !== threadId ||
          !isRecoverableThreadError(error)
        )
          throw error;
        res.json({
          ok: true,
          workspace,
          thread: { id: threadId, preview: "", cwd: workspace.workspacePath },
          messages: [],
        });
      }
    }),
  );
  app.post(
    "/agent/codex/threads/:threadId/resume",
    route(async (req, res) => {
      if (session.codexBusy)
        return res
          .status(409)
          .json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
      const workspace = ensureSiteWorkspace(config, configFile);
      const threadId = routeParam(req.params.threadId);
      const result = await resumeCodexThread(
        emit,
        threadId,
        workspace.workspacePath,
        permissionMode(req.body?.permissionMode),
      );
      const nextWorkspace = setActiveThread(threadId);
      res.json({ ok: true, workspace: nextWorkspace, ...result });
    }),
  );
  app.post(
    "/agent/codex/threads/:threadId/delete",
    route(async (req, res) => {
      if (session.codexBusy)
        return res
          .status(409)
          .json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
      const workspace = ensureSiteWorkspace(config, configFile);
      const threadId = routeParam(req.params.threadId);
      await archiveCodexThread(emit, threadId, workspace.workspacePath);
      setActiveThread(
        workspace.activeThreadId === threadId
          ? ""
          : workspace.activeThreadId || "",
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/agent/codex/turn",
    route(async (req, res) => {
      if (session.codexBusy)
        return res
          .status(409)
          .json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
      const attachments = Array.isArray(req.body?.attachments)
        ? (req.body.attachments as AgentAttachment[])
        : [];
      const workspace = ensureSiteWorkspace(config, configFile);
      const prompt = String(req.body?.prompt || "");
      if (!prompt.trim())
        return res.status(400).json({ ok: false, error: "请输入任务内容" });
      const clientId = String(req.body?.clientId || "");
      const model = String(req.body?.model || "") || undefined;
      const effort = reasoningEffort(req.body?.effort);
      logger.info("Codex turn accepted", {
        threadId: req.body?.threadId,
        model: model || "default",
        reasoningEffort: effort || "default",
        promptLength: prompt.length,
        attachmentCount: attachments.length,
      });
      session.setCodexState({
        busy: true,
        threadId: String(req.body?.threadId || workspace.activeThreadId || ""),
        turnId: "",
      });
      try {
        let threadId = String(
          req.body?.threadId || workspace.activeThreadId || "",
        );
        let turnId = "";
        if (!threadId) {
          const thread = await startCodexThread(
            emit,
            workspace.workspacePath,
            permissionMode(req.body?.permissionMode),
          );
          threadId = String((thread as Record<string, unknown>).id || "");
          setActiveThread(threadId, { emptyThread: true });
        } else if (threadId !== workspace.activeThreadId) {
          await verifyCodexThreadWorkspace(
            emit,
            threadId,
            workspace.workspacePath,
          );
          setActiveThread(threadId);
        }
        const attachmentRefs = session.setTurnAttachments(
          clientId,
          attachments,
        );
        const chatMessage = {
          sourceClientId: clientId,
          message: {
            id: String(req.body?.messageId || Date.now()),
            role: "user",
            text: String(
              req.body?.messageText ||
                prompt ||
                `发送了 ${attachments.length} 张图片`,
            ),
          },
        };
        let chatThreadId = "";
        /** 将当前 turn 事件固定广播到实际线程。 */
        const turnEmit = (type: string, payload: unknown) => {
          const data =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : { value: payload };
          session.emitThread(type, threadId, {
            ...data,
            ...(turnId ? { turn_id: turnId } : {}),
          });
        };
        void runCodexTurn(
          withAttachmentContext(prompt, attachmentRefs),
          turnEmit,
          attachments,
          {
            threadId,
            cwd: workspace.workspacePath,
            permissionMode: permissionMode(req.body?.permissionMode),
            model,
            effort,
            appEmit: emit,
            onStart: clientId ? () => session.bindClient(clientId) : undefined,
            onThread: (actualThreadId) => {
              if (actualThreadId !== threadId) {
                threadId = actualThreadId;
                setActiveThread(threadId, { emptyThread: true });
              }
              session.setCodexState({ busy: true, threadId, turnId: "" });
              if (chatThreadId !== threadId) {
                chatThreadId = threadId;
                session.emitThread("chat_message", threadId, chatMessage);
              }
            },
            onTurn: (actualTurnId) => {
              turnId = actualTurnId;
              logger.info("Codex turn started", {
                threadId,
                turnId,
                model: model || "default",
                reasoningEffort: effort || "default",
              });
              session.setCodexState({ busy: true, threadId, turnId });
            },
            onFinish: () => {
              logger.info("Codex turn finished", { threadId, turnId });
              session.clearTurnAttachments(clientId);
              if (clientId) session.releaseClient(clientId);
              session.setCodexState({ busy: false, threadId, turnId });
            },
          },
        );
        res.json({ ok: true, threadId });
      } catch (error) {
        session.setCodexState({
          busy: false,
          threadId: String(
            req.body?.threadId || workspace.activeThreadId || "",
          ),
          turnId: "",
        });
        throw error;
      }
    }),
  );
  app.post(
    "/agent/codex/approval",
    route(async (req, res) => {
      const decision = String(req.body?.decision || "");
      if (
        !["accept", "acceptForSession", "decline", "cancel"].includes(decision)
      )
        return res.status(400).json({ ok: false, error: "无效的审批决定" });
      const ok = await resolveCodexApproval(
        String(req.body?.requestId || ""),
        decision,
      );
      res
        .status(ok ? 200 : 409)
        .json({ ok, ...(ok ? {} : { error: "审批请求已失效" }) });
    }),
  );
  app.post(
    "/agent/codex/interrupt",
    route(async (req, res) =>
      res.json({
        ok: await interruptCodexTurn(String(req.body?.threadId || "")),
      }),
    ),
  );
  app.post("/agent/claude/turn", (req, res) => {
    runClaudeTurn(String(req.body?.prompt || ""), emit);
    res.json({ ok: true });
  });
  app.use((_req, res) =>
    res.status(404).json({ ok: false, error: "not found" }),
  );
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof WorkspacePathError) {
      logger.warn("Blocked path outside workspace", {
        method: req.method,
        path: req.path,
      });
      return void res
        .status(403)
        .json({ ok: false, error: "文件不在允许的工作空间内" });
    }
    logger.error("HTTP request failed", {
      method: req.method,
      path: req.path,
      error,
    });
    const incomingStatus =
      "status" in error
        ? Number((error as Error & { status?: number }).status)
        : 0;
    const status =
      incomingStatus === 400 || incomingStatus === 413 ? incomingStatus : 500;
    const message =
      status === 400
        ? "请求内容格式不正确"
        : status === 413
          ? "请求内容超过 30MB 限制"
          : "本地 Agent 请求失败";
    res.status(status).json({ ok: false, error: message });
  });

  return app;
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) =>
    void handler(req, res).catch(next);
}

/** 从 Express 路由参数中读取单个字符串。 */
function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] || "" : value;
}

function permissionMode(value: unknown): AgentPermissionMode {
  return value === "automatic" || value === "full" ? value : "request";
}

function reasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
    ? value
    : undefined;
}

/** 使用当前操作系统的文件管理器定位本地文件。 */
function revealLocalFile(filePath: string, isDirectory: boolean) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const args =
    process.platform === "darwin"
      ? ["-R", filePath]
      : process.platform === "win32"
        ? [isDirectory ? filePath : `/select,${filePath}`]
        : [isDirectory ? filePath : path.dirname(filePath)];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
  return new URL(req.originalUrl || req.url || "/", config.url);
}

/** 设置跨域响应头并记录通过 token 授权的来源。 */
function setCors(
  req: Request,
  res: Response,
  url: URL,
  config: CanvasAgentConfig,
  configFile = CONFIG_FILE,
) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type,x-canvas-agent-token",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (url.searchParams.has("token")) return true;
  if (
    !origin ||
    req.method === "OPTIONS" ||
    url.pathname === "/health" ||
    url.pathname === "/config"
  )
    return true;
  if (!isHttpOrigin(origin)) return false;
  config.origins ||= [];
  if (validToken(req, config.token) && !config.origins.includes(origin)) {
    if (config.origins.length >= 20) return false;
    config.origins.push(origin);
    saveConfig(config, configFile);
  }
  res.setHeader("Vary", "Origin");
  return config.origins.includes(origin);
}

function isHttpOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** 以常量时间校验请求头中的连接 token。 */
function validToken(req: Request, token: string) {
  const header = req.headers["x-canvas-agent-token"];
  const candidate = typeof header === "string" ? header : "";
  const expectedHash = crypto.createHash("sha256").update(token).digest();
  const candidateHash = crypto.createHash("sha256").update(candidate).digest();
  const matches = crypto.timingSafeEqual(expectedHash, candidateHash);
  return candidate.length > 0 && matches;
}

function detectImageMime(header: Buffer) {
  if (
    header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return "image/jpeg";
  const prefix = header.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (
    header.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(header.subarray(8, 12).toString("ascii"))
  )
    return "image/avif";
  return "";
}

/** 向 Agent 提示词追加本轮图片附件引用说明。 */
function withAttachmentContext(
  prompt: string,
  attachments: Array<{ id: string; name: string }>,
) {
  if (!attachments.length) return prompt;
  const list = attachments
    .map(
      (item, index) =>
        `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}`,
    )
    .join("\n");
  return `${prompt}\n\n本轮可用图片附件（顺序与图片输入一致）：\n${list}\n需要把附件放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。`;
}
