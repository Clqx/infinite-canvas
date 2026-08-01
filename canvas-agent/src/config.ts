import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = fs.readFileSync(new URL("../agent-instructions.md", import.meta.url), "utf8");
const initializedWorkspaces = new Set<string>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig };

const workspaceSchema = z
    .object({
        workspacePath: z.string().trim().min(1).max(4096),
        activeThreadId: z.string().trim().min(1).max(512).optional(),
        pinnedThreadIds: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
    })
    .strict();

const configSchema = z
    .object({
        url: z.string().refine(isLoopbackHttpUrl, "Canvas Agent URL must use loopback HTTP"),
        token: z.string().max(256),
        origins: z.array(z.string().refine(isHttpOrigin, "Invalid HTTP origin")).max(20).optional(),
        workspace: workspaceSchema.optional(),
    })
    .strict();

/** 读取本地 Canvas Agent 配置，不存在、损坏或 token 过弱时生成安全配置。 */
export function loadConfig(create = false, configFile = CONFIG_FILE): CanvasAgentConfig {
    let config: CanvasAgentConfig;
    try {
        config = configSchema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
    } catch {
        config = defaultConfig();
        if (create) {
            backupInvalidConfig(configFile);
            saveConfig(config, configFile);
        }
        return config;
    }
    if (isStrongToken(config.token)) return config;
    const next = { ...config, token: createToken() };
    if (create) saveConfig(next, configFile);
    return next;
}

/** Preserve an unreadable or invalid configuration before replacing it. */
function backupInvalidConfig(configFile: string) {
    if (!fs.existsSync(configFile)) return;
    const suffix = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const backupFile = `${configFile}.corrupt-${suffix}`;
    fs.renameSync(configFile, backupFile);
    restrictMode(backupFile, 0o600);
}

/** 将 Canvas Agent 配置原子写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig, configFile = CONFIG_FILE) {
    const safeConfig = configSchema.parse(config);
    if (!isStrongToken(safeConfig.token)) throw new Error("Canvas Agent token is too weak");
    const configDir = path.dirname(configFile);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    restrictMode(configDir, 0o700);
    const temporaryFile = path.join(configDir, `.${path.basename(configFile)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
        fs.writeFileSync(temporaryFile, `${JSON.stringify(safeConfig, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        restrictMode(temporaryFile, 0o600);
        fs.renameSync(temporaryFile, configFile);
        restrictMode(configFile, 0o600);
    } finally {
        try {
            fs.unlinkSync(temporaryFile);
        } catch {}
    }
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig, configFile = CONFIG_FILE) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(path.dirname(configFile), "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config, configFile);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>, configFile = CONFIG_FILE) {
    const current = ensureSiteWorkspace(config, configFile);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config, configFile);
    return config.workspace;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# Infinite Canvas Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    initializedWorkspaces.add(workspacePath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

function defaultConfig(): CanvasAgentConfig {
    const requestedPort = Number(process.env.PORT);
    const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535 ? requestedPort : DEFAULT_PORT;
    return { url: `http://127.0.0.1:${port}`, token: createToken() };
}

function createToken() {
    for (;;) {
        const token = crypto.randomBytes(18).toString("hex");
        if (isStrongToken(token)) return token;
    }
}

function isStrongToken(token: string) {
    return /^[0-9a-f]{36}$/.test(token) && new Set(token).size >= 8;
}

function isLoopbackHttpUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
    } catch {
        return false;
    }
}

function isHttpOrigin(value: string) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value && url.username === "" && url.password === "";
    } catch {
        return false;
    }
}

function restrictMode(target: string, mode: number) {
    if (process.platform === "win32") return;
    fs.chmodSync(target, mode);
}

/** 从当前包信息中读取 Canvas Agent 版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
