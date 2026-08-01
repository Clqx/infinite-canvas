import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

type AgentConfigResponse = { ok?: boolean; url?: string; token?: string; hasToken?: boolean };

export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        await fetchAgent(`${endpoint}/canvas/state?clientId=${encodeURIComponent(clientId)}`, token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
    } catch {}
}

export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetchAgent(`${endpoint}/canvas/activate?clientId=${encodeURIComponent(clientId)}`, token, { method: "POST" });
    } catch {}
}

export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetchAgent(`${endpoint}/canvas/result?clientId=${encodeURIComponent(clientId)}`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function postCodexApproval(endpoint: string, token: string, requestId: string, decision: "accept" | "acceptForSession" | "decline") {
    await fetchAgentJson(endpoint, token, "/agent/codex/approval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }) });
}

export async function revealAgentLocalFile(endpoint: string, token: string, path: string) {
    await fetchAgentJson(endpoint, token, "/agent/local-file/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const res = await fetchAgent(`${endpoint}${path}`, token, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new Error(data.error || data.msg || "本地 Agent 请求失败");
    return data;
}

export async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${endpoint}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

export function fetchAgent(url: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-canvas-agent-token", token);
    return fetch(url, { ...init, headers, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
}
