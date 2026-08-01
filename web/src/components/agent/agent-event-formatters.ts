import { isSiteTool, SITE_TOOL_LABELS } from "@/lib/agent/agent-site-tools";
import { summarizeCanvasAgentOps, type CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { randomId } from "@/lib/utils";
import { useAgentStore, type AgentAttachment, type AgentChatItem, type AgentEventLog, type AgentTokenUsage } from "@/stores/use-agent-store";
import type { AgentChatAttachment } from "./agent-chat-message";

export type AgentEventPayload = {
    agent?: string;
    type?: string;
    threadId?: string;
    thread_id?: string;
    turn_id?: string;
    item?: AgentEventItem;
    error?: { message?: string };
    message?: string;
    status?: string;
    explanation?: unknown;
    plan?: unknown;
    usage?: Record<string, unknown>;
    duration_ms?: number;
};
export type AgentEventItem = {
    id?: string;
    type?: string;
    text?: unknown;
    delta?: unknown;
    message?: unknown;
    server?: string;
    tool?: string;
    status?: string;
    arguments?: unknown;
    result?: unknown;
    error?: { message?: string };
    command?: unknown;
    cwd?: unknown;
    aggregatedOutput?: unknown;
    exitCode?: unknown;
    durationMs?: unknown;
    contentItems?: unknown;
    success?: unknown;
    changes?: unknown;
    summary?: unknown;
    query?: unknown;
    action?: unknown;
    path?: unknown;
    savedPath?: unknown;
    revisedPrompt?: unknown;
};
export type AgentUserDetail = { kind: string; status: string; rows?: Array<{ label: string; value: string }>; output?: string; files?: Array<{ path: string; action?: string }>; tasks?: Array<{ step: string; status: string }>; explanation?: string };

export type AgentLogContext = { endpoint: string; connected: boolean; enabled: boolean; activity: string; waiting: boolean; sending: boolean; messages: number; pendingTool?: string };

export function agentMessageToChatMessage(item: AgentChatItem) {
    return { ...item, meta: item.role === "user" || item.role === "assistant" ? undefined : item.meta, attachments: item.attachments?.map(agentAttachmentToChatAttachment) };
}

export function agentAttachmentToChatAttachment(item: AgentAttachment): AgentChatAttachment {
    return { id: item.id, name: item.name, url: item.dataUrl || item.url };
}

export function formatAgentEvent(event: AgentEventPayload): Omit<AgentChatItem, "id"> | null {
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "error") return { role: "error", title: "错误", text: normalizeText(item.message), detail: item };
    if (event.type === "item.completed" && item?.type === "agent_message") return { role: "assistant", title: "Codex", text: stringText(item.text) };
    return null;
}

export function formatAgentActivity(event: AgentEventPayload): Omit<AgentChatItem, "id"> | null {
    const item = event.item;
    if (!item || (event.type !== "item.started" && event.type !== "item.completed")) return null;
    const completed = event.type === "item.completed";
    const status = String(item.status || (completed ? "completed" : "inProgress"));
    if (item.type === "reasoning") {
        const text = readableText(item.summary) || (completed ? "已完成分析" : activityPlaceholder(item.type));
        return { role: "tool", title: "思考摘要", text, detail: { kind: "reasoning", status } };
    }
    if (item.type === "plan") {
        const text = stringText(item.text) || activityPlaceholder(item.type);
        return { role: "tool", title: "执行计划", text, detail: { kind: "plan", status } };
    }
    if (item.type === "command_execution") {
        const command = stringText(item.command) || activityPlaceholder(item.type);
        return { role: "tool", title: "执行命令", text: command, detail: commandActivityDetail(item, status) };
    }
    if (item.type === "file_change") {
        const files = activityFiles(item.changes);
        return { role: "tool", title: "修改文件", text: fileActivitySummary(files, completed), detail: { kind: "file", status, files } };
    }
    if (item.type === "web_search") {
        return { role: "tool", title: "搜索资料", text: webSearchSummary(item), detail: { kind: "search", status, rows: webSearchDetailRows(item) } };
    }
    if (item.type === "image_view") return { role: "tool", title: "查看图片", text: stringText(item.path) || "正在查看图片", detail: { kind: "image", status } };
    if (item.type === "image_generation") return { role: "tool", title: "内置生图", text: completed ? "图片生成完成" : "正在生成图片…", detail: { kind: "image", status } };
    if (item.type === "context_compaction") return { role: "tool", title: "整理上下文", text: completed ? "已整理当前对话，继续处理任务" : "正在整理当前对话…", detail: { kind: "context", status } };
    if (isMcpToolItem(item) && isReadTool(String(item.tool || ""))) {
        const name = String(item.tool || "");
        return { role: "tool", title: toolName(name), text: completed ? item.error?.message || toolSummary(item) : `正在${toolAction(name)}…`, detail: toolDetail(item, item.error ? "failed" : status) };
    }
    if (item.type === "dynamic_tool_call") {
        const name = String(item.tool || "");
        const title = toolName(name);
        const failed = Boolean(item.error) || item.success === false || ["failed", "error"].includes(status);
        const currentStatus = failed ? "failed" : status;
        return {
            role: "tool",
            title,
            text: completed ? item.error?.message || readableText(item.contentItems) || `${title}${failed ? "失败" : "完成"}` : `正在${toolAction(name)}…`,
            detail: toolDetail(item, currentStatus),
        };
    }
    if (item.type === "collab_tool_call") return { role: "tool", title: "协作处理", text: completed ? "已完成协作任务" : "正在协作处理任务…", detail: { kind: "tool", status } };
    return null;
}

export function formatAgentPlan(event: AgentEventPayload): Omit<AgentChatItem, "id"> | null {
    const tasks = planTasks(event.plan);
    if (!tasks.length) return null;
    const completed = tasks.filter((item) => item.status === "completed").length;
    return {
        role: "tool",
        title: "任务进度",
        text: `已完成 ${completed}/${tasks.length} 项`,
        detail: { kind: "todo", status: completed === tasks.length ? "completed" : "inProgress", tasks, explanation: stringText(event.explanation) },
    };
}

function planTasks(value: unknown) {
    return (Array.isArray(value) ? value : []).flatMap((item) => {
        const step = stringText(objectField(item, "step")).trim();
        return step ? [{ step, status: stringText(objectField(item, "status")) || "pending" }] : [];
    });
}

export function turnPlanStatus(detail: unknown, turnStatus?: string) {
    const tasks = planTasks(objectField(detail, "tasks"));
    if (turnStatus === "failed") return "failed";
    if (turnStatus === "interrupted") return "interrupted";
    if (tasks.length && tasks.every((item) => item.status === "completed")) return "completed";
    return turnStatus === "completed" ? "finished" : "inProgress";
}

export function activityDeltaFallback(item: AgentEventItem, delta: string): AgentChatItem {
    if (item.type === "command_execution") return { id: item.id || randomId(), role: "tool", title: "执行命令", text: activityPlaceholder(item.type), detail: { kind: "command", status: "inProgress", output: delta } };
    return { id: item.id || randomId(), role: "tool", title: item.type === "plan" ? "执行计划" : "思考摘要", text: delta, detail: { kind: activityKind(item.type), status: "inProgress" } };
}

export function activityPlaceholder(type?: string) {
    if (type === "plan") return "正在整理执行步骤…";
    if (type === "command_execution") return "正在执行命令…";
    return "正在分析任务…";
}

export function activityKind(type?: string) {
    if (type === "command_execution") return "command";
    if (type === "plan") return "plan";
    return "reasoning";
}

export function activityDetail(value: unknown, kind: string, status: string): AgentUserDetail {
    const current = value && typeof value === "object" ? (value as Partial<AgentUserDetail>) : {};
    return { kind, status, rows: current.rows, output: current.output, files: current.files, tasks: current.tasks, explanation: current.explanation };
}

function commandActivityDetail(item: AgentEventItem, status: string): AgentUserDetail {
    const rows = [detailRow("工作目录", item.cwd), detailRow("退出状态", item.exitCode), durationDetailRow(item.durationMs)].flatMap((row) => (row ? [row] : []));
    return { kind: "command", status, rows, output: item.error?.message || stringText(item.aggregatedOutput) };
}

function activityFiles(value: unknown) {
    return (Array.isArray(value) ? value : []).flatMap((change) => {
        const path = stringText(objectField(change, "path"));
        return path ? [{ path, action: changeAction(objectField(change, "kind")) }] : [];
    });
}

function fileActivitySummary(files: Array<{ path: string; action?: string }>, completed: boolean) {
    if (!files.length) return completed ? "已完成文件修改" : "正在准备文件修改…";
    if (files.length === 1) return `${completed ? "已" : "正在"}${files[0].action || "修改"} ${files[0].path}`;
    const names = files.slice(0, 3).map((file) => file.path).join("、");
    return `${completed ? "已修改" : "正在修改"} ${files.length} 个文件：${names}${files.length > 3 ? " 等" : ""}`;
}

function webSearchSummary(item: AgentEventItem) {
    const action = item.action;
    const type = stringText(objectField(action, "type"));
    if (type === "openPage") return `打开网页：${stringText(objectField(action, "url"))}`;
    if (type === "findInPage") return `在网页中查找“${stringText(objectField(action, "pattern")) || "相关内容"}”`;
    return `搜索：${stringText(item.query) || stringText(objectField(action, "query")) || "相关资料"}`;
}

function webSearchDetailRows(item: AgentEventItem) {
    const action = item.action;
    return [detailRow("关键词", item.query || objectField(action, "query")), detailRow("网页", objectField(action, "url"))].flatMap((row) => (row ? [row] : []));
}

function readableText(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map(readableText).filter(Boolean).join("\n");
    return readableText(objectField(value, "text"));
}

function detailRow(label: string, value: unknown) {
    return value === undefined || value === null || value === "" ? null : { label, value: String(value) };
}

function durationDetailRow(value: unknown) {
    const duration = Number(value || 0);
    return duration > 0 ? { label: "耗时", value: `${(duration / 1000).toFixed(1)} 秒` } : null;
}

function changeAction(value: unknown) {
    if (value === "add") return "新增";
    if (value === "delete") return "删除";
    return "修改";
}

export function parseEventData<T>(event: Event) {
    try {
        return JSON.parse((event as MessageEvent).data) as T;
    } catch {
        return null;
    }
}

export function isCurrentThreadEvent(event: { threadId?: string; thread_id?: string }) {
    const threadId = event.threadId || event.thread_id || "";
    return Boolean(threadId) && threadId === useAgentStore.getState().activeThreadId;
}

export function formatLogText(logs: AgentEventLog[], context: AgentLogContext) {
    const head = [
        "Infinite Canvas Agent 诊断",
        `地址：${context.endpoint}`,
        `连接：${context.connected ? "在线" : context.enabled ? "连接中" : "未启用"} · 状态：${context.activity}`,
        `消息：${context.messages} · 工具：${context.pendingTool ? toolName(context.pendingTool) : "无"}`,
    ].join("\n");
    const body = logs.map((item) => `${item.time} ${item.title}${item.text && item.text !== item.title ? ` · ${item.text}` : ""}`).join("\n");
    return [head, body || "暂无事件日志"].join("\n\n");
}

export function formatLogJson(logs: AgentEventLog[], context: AgentLogContext) {
    return JSON.stringify({ context, logs: logs.map(({ time, title, text, raw }) => ({ time, title, text, raw })) }, null, 2);
}

export function formatAgentEventLog(event: AgentEventPayload) {
    const item = event.item;
    if (event.type === "thread.started") return { title: "创建会话", text: shortId(event.thread_id) };
    if (event.type === "turn.started") return { title: "开始处理", text: shortId(event.turn_id) };
    if (event.type === "plan.updated") {
        const tasks = planTasks(event.plan);
        return { title: "更新任务进度", text: `已完成 ${tasks.filter((item) => item.status === "completed").length}/${tasks.length} 项` };
    }
    if (event.type === "turn.completed" && event.status === "failed") return { title: "处理失败", text: agentErrorView(event.error?.message).text };
    if (event.type === "turn.completed") return { title: event.status === "interrupted" ? "处理已停止" : "处理完成", text: turnSummary(event) };
    if (event.type === "turn.failed" || event.type === "error") return { title: "处理失败", text: agentErrorView(event.message || event.error?.message).text };
    if (event.type === "item.started" && isMcpToolItem(item)) return { title: "调用工具", text: toolName(String(item?.tool || "")) };
    if (event.type === "item.completed" && isMcpToolItem(item)) return { title: item.error ? "工具失败" : "工具完成", text: `${toolName(String(item?.tool || ""))}${item.error?.message ? ` · ${item.error.message}` : ""}` };
    if (event.type === "item.completed" && item?.type === "agent_message") return { title: "收到回复", text: compactText(stringText(item.text)) };
    return null;
}

function turnSummary(event: AgentEventPayload) {
    return event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)} 秒` : "完成";
}

export function agentErrorView(value: unknown) {
    const text = normalizeText(value);
    if (/selected model is at capacity/i.test(text)) return { title: "模型暂时繁忙", text: "当前选择的模型请求量过大，暂时无法处理。请稍后重试，或切换其他模型后再试。" };
    return { title: "任务失败", text: text || "Codex 未能完成本次任务，请稍后重试。" };
}

export function eventUsage(event: AgentEventPayload): AgentTokenUsage {
    return {
        input: numberField(event.usage, "input_tokens"),
        cached: numberField(event.usage, "cached_input_tokens"),
        output: numberField(event.usage, "output_tokens"),
    };
}

function shortId(value?: string) {
    return value ? value.slice(0, 8) : "";
}

export function compactText(value: string, maxLength = 120) {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function isConnectionErrorMessage(item: AgentChatItem) {
    return item.role === "error" && /连接失败|无法连接本地 Agent|本地 Agent 连接失败/.test(item.text);
}

export function toolName(name: string) {
    if (name === "imagegen" || name.endsWith("__imagegen")) return "生成图片";
    if (name === "view_image" || name.endsWith("__view_image")) return "查看图片";
    if (name === "exec" || name === "exec_command" || name.endsWith("__exec_command")) return "执行命令";
    if (name === "apply_patch" || name.endsWith("__apply_patch")) return "修改文件";
    if (name === "web__run" || name.endsWith("__web__run")) return "搜索资料";
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_node") return "创建节点";
    if (name === "canvas_create_attachment_nodes") return "添加附件图片";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_text_nodes") return "批量创建文本";
    if (name === "canvas_create_config_node") return "创建生成配置";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_update_node") return "更新节点";
    if (name === "canvas_update_node_text") return "更新文本";
    if (name === "canvas_move_nodes") return "移动节点";
    if (name === "canvas_resize_node") return "调整节点尺寸";
    if (name === "canvas_delete_nodes") return "删除节点";
    if (name === "canvas_connect_nodes") return "连接节点";
    if (name === "canvas_select_nodes") return "选择节点";
    if (name === "canvas_set_viewport") return "调整视口";
    if (name === "canvas_run_generation") return "触发生成";
    if (name === "site_navigate") return "打开页面";
    if (isSiteTool(name)) return SITE_TOOL_LABELS[name];
    return name ? `调用工具：${name}` : "工具操作";
}

export function siteToolSummary(name: string, result: unknown) {
    const data = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    if (name === "canvas_list_projects") return `共 ${numberField(data, "total")} 个画布`;
    if (name === "prompts_search") return `找到 ${numberField(data, "total")} 条提示词`;
    if (name === "assets_list") return `共 ${numberField(data, "total")} 个资产`;
    if (name === "assets_add") return "已加入我的资产";
    if (name === "generation_get_status") {
        const summary = data.summary && typeof data.summary === "object" ? (data.summary as Record<string, unknown>) : {};
        return `共 ${numberField(data, "total")} 个任务，排队 ${numberField(summary, "queued")}，运行中 ${numberField(summary, "running")}，成功 ${numberField(summary, "succeeded")}，失败 ${numberField(summary, "failed")}`;
    }
    if (name === "workbench_image_generate" || name === "workbench_video_generate") return typeof data.note === "string" ? data.note : "已在工作台执行";
    if (name === "workbench_image_get_config" || name === "workbench_video_get_config") return "已读取工作台配置";
    return "已完成";
}

export function isReadTool(name: string) {
    return name === "canvas_get_state" || name === "canvas_get_selection" || name === "canvas_export_snapshot";
}

function isMcpToolItem(item?: AgentEventItem): item is AgentEventItem {
    return item?.type === "mcp_tool_call";
}

export function toolDetail(item: AgentEventItem | undefined, status: string): AgentUserDetail {
    const name = String(item?.tool || "");
    return { kind: "tool", status, rows: toolInputRows(name, item?.arguments), ...(item?.error?.message ? { output: item.error.message } : {}) };
}

export function toolCallDetail(name: string, input: unknown, status: string, error = ""): AgentUserDetail {
    return { kind: "tool", status, rows: toolInputRows(name, input), ...(error ? { output: error } : {}) };
}

function toolInputRows(name: string, input: unknown) {
    if (name === "site_navigate") return [detailRow("目标页面", routeName(stringText(objectField(input, "path")) || "/"))].flatMap((row) => (row ? [row] : []));
    if (name === "prompts_search") return [detailRow("搜索内容", objectField(input, "query"))].flatMap((row) => (row ? [row] : []));
    if (name === "canvas_create_text_node") return [detailRow("文本内容", objectField(input, "text"))].flatMap((row) => (row ? [row] : []));
    if (name === "canvas_apply_ops") return [detailRow("操作内容", summarizeCanvasAgentOps((objectField(input, "ops") as CanvasAgentOp[] | undefined) || []))].flatMap((row) => (row ? [row] : []));
    if (name === "canvas_create_attachment_nodes") return [detailRow("图片数量", Array.isArray(objectField(input, "nodes")) ? (objectField(input, "nodes") as unknown[]).length : 0)].flatMap((row) => (row ? [row] : []));
    return [];
}

export function toolSummary(item?: AgentEventItem) {
    const result = parseToolResult(item?.result);
    const nodeField = objectField(result, "nodes");
    const connectionField = objectField(result, "connections");
    const nodes = Array.isArray(nodeField) ? nodeField : [];
    const connections = Array.isArray(connectionField) ? connectionField : [];
    if (item?.tool === "canvas_get_state" && (Array.isArray(nodeField) || Array.isArray(connectionField))) return canvasContentSummary(nodes, connections.length);
    if (Array.isArray(nodeField) || Array.isArray(connectionField)) return `读取到 ${nodes.length} 个节点，${connections.length} 条连线`;
    return "工具调用完成";
}

function canvasContentSummary(nodes: unknown[], connections: number) {
    const counts = nodes.reduce<Record<string, number>>((result, node) => {
        const type = stringText(objectField(node, "type")) || "other";
        result[type] = (result[type] || 0) + 1;
        return result;
    }, {});
    const known = new Set(["text", "image", "config", "video", "audio", "group"]);
    const other = Object.entries(counts).reduce((total, [type, count]) => total + (known.has(type) ? 0 : count), 0);
    const parts = [
        counts.text ? `${counts.text} 个文本` : "",
        counts.image ? `${counts.image} 张图片` : "",
        counts.config ? `${counts.config} 个配置` : "",
        counts.video ? `${counts.video} 个视频` : "",
        counts.audio ? `${counts.audio} 个音频` : "",
        counts.group ? `${counts.group} 个分组` : "",
        other ? `${other} 个其他节点` : "",
        connections ? `${connections} 条连线` : "",
    ].filter(Boolean);
    return parts.length ? parts.join("、") : "当前画布为空";
}

export function toolAction(name: string) {
    const label = toolName(name);
    if (label.startsWith("读取") || label.startsWith("查看") || label.startsWith("搜索") || label.startsWith("打开")) return label;
    return `执行${label}`;
}

export function routeName(path: string) {
    if (path === "/") return "首页";
    if (path === "/canvas") return "画布页面";
    if (path.startsWith("/canvas/")) return "指定画布";
    if (path.startsWith("/image")) return "生图工作台";
    if (path.startsWith("/video")) return "视频工作台";
    if (path.startsWith("/prompts")) return "提示词中心";
    if (path.startsWith("/assets")) return "我的素材";
    if (path.startsWith("/config")) return "配置页面";
    return path;
}

export function workingActivity(item?: AgentChatItem) {
    const status = String(objectField(item?.detail, "status") || "");
    const output = stringText(objectField(item?.detail, "output"));
    const key = `${item?.id || "waiting"}-${status}-${item?.text || ""}-${output.length}`;
    if (item?.role !== "tool") return { key, text: "正在思考..." };
    if (["inProgress", "in_progress", "running", "pending"].includes(status)) return { key, text: `${item.title || "工具操作"}正在进行...` };
    if (item.title === "读取画布") return { key, text: "画布已读取，Codex 正在整理结果..." };
    return { key, text: `${item.title || "工具操作"}已完成，Codex 正在继续处理...` };
}

export function currentPlanMessage(messages: AgentChatItem[]) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isPlanMessage(message)) return message;
        if (message.role === "user") return;
    }
}

export function latestPlanMessage(messages: AgentChatItem[]) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (isPlanMessage(messages[index])) return messages[index];
    }
}

export function isPlanMessage(message: AgentChatItem) {
    return message.role === "tool" && objectField(message.detail, "kind") === "todo";
}

function parseToolResult(result: unknown) {
    const content = objectField(result, "content");
    const text = Array.isArray(content)
        ? content
              .map((item) => objectField(item, "text"))
              .filter((item): item is string => typeof item === "string")
              .join("\n")
        : "";
    try {
        return text ? JSON.parse(text) : result;
    } catch {
        return text || result;
    }
}

export function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

export function stringText(value: unknown) {
    return typeof value === "string" ? value : "";
}

export function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numberField(value: unknown, key: string) {
    const field = objectField(value, key);
    return typeof field === "number" ? field : 0;
}

export function mergeAgentText(prev: string, next: string) {
    if (!next || prev === next || prev.endsWith(next)) return prev;
    if (next.startsWith(prev)) return next;
    for (let size = Math.min(prev.length, next.length); size > 0; size--) {
        if (prev.endsWith(next.slice(0, size))) return `${prev}${next.slice(size)}`;
    }
    const half = Math.floor(prev.length / 2);
    if (prev.length > 12 && next.length > 12 && prev.slice(half) === next.slice(0, prev.length - half)) return prev;
    return `${prev}${next}`;
}

export function promptWithAttachments(text: string, attachments: AgentAttachment[]) {
    return text || (attachments.length ? "请处理上传的图片附件。" : "");
}

export function attachmentPayloadBytes(attachments: AgentAttachment[]) {
    return attachments.reduce((total, item) => total + item.dataUrl.length, 0);
}

export function formatBytes(bytes: number) {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

export function isCanvasWriteTool(name: string) {
    return name === "canvas_apply_ops" || name === "canvas_create_attachment_nodes";
}

export function normalizeHistoryMessages(messages: AgentChatItem[]) {
    return messages
        .map((item, index) => ({
            ...item,
            id: item.id || `history-${index}`,
            text: normalizeText(item.text),
            streamId: undefined,
        }))
        .filter((item) => item.text);
}

export function mergeHistoryAttachments(messages: AgentChatItem[], currentMessages: AgentChatItem[]) {
    const currentUsers = currentMessages.filter((item) => item.role === "user" && item.attachments?.length).reverse();
    return [...messages]
        .reverse()
        .map((item) => {
            if (item.role !== "user") return item;
            const index = currentUsers.findIndex((current) => current.text === item.text || current.historyText === item.text);
            if (index < 0) return item;
            const current = currentUsers.splice(index, 1)[0];
            return { ...item, id: current.id, text: current.text, historyText: current.historyText, attachments: current.attachments };
        })
        .reverse();
}

export function mergeHistoryMessages(historyMessages: AgentChatItem[], currentMessages: AgentChatItem[]) {
    if (!currentMessages.length) return historyMessages;
    const remaining = [...historyMessages];
    const messages = currentMessages.map((current) => {
        const index = remaining.findIndex((history) => history.id === current.id || ((current.role === "user" || current.role === "assistant") && history.role === current.role && history.text === current.text));
        if (index < 0) return current;
        const history = remaining.splice(index, 1)[0];
        return { ...current, ...history, id: current.id, attachments: current.attachments || history.attachments };
    });
    return [...messages, ...remaining];
}
