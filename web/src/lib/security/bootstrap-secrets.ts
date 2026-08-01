export type AgentBootstrap = {
    url: string;
    token: string;
};

const SENSITIVE_QUERY_KEYS = new Set(["apikey", "agenttoken", "agenturl", "baseurl", "token"]);
let agentBootstrap: AgentBootstrap | null = null;
let removedLegacySecrets = false;

export function initializeSecurityBootstrap() {
    if (typeof window === "undefined") return;
    const result = sanitizeBootstrapUrl(window.location.href);
    if (result.agent) agentBootstrap = result.agent;
    if (result.removedLegacySecrets) removedLegacySecrets = true;
    if (result.changed) window.history.replaceState(window.history.state, "", result.relativeUrl);
}

export function sanitizeBootstrapUrl(value: string) {
    const url = new URL(value);
    let changed = false;
    let removedLegacy = false;
    let agent: AgentBootstrap | null = null;

    for (const key of [...url.searchParams.keys()]) {
        if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) continue;
        url.searchParams.delete(key);
        removedLegacy = true;
        changed = true;
    }

    const fragment = parseBootstrapFragment(url.hash);
    if (fragment) {
        const token = getParamIgnoreCase(fragment, "agentToken").trim();
        const endpoint = getParamIgnoreCase(fragment, "agentUrl").trim();
        if (token && endpoint && isLoopbackAgentUrl(endpoint)) agent = { url: endpoint, token };
        else if (token || endpoint) removedLegacy = true;
        for (const key of [...fragment.keys()]) {
            if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) fragment.delete(key);
        }
        url.hash = fragment.size ? `#${fragment.toString()}` : "";
        changed = true;
    }

    return { relativeUrl: `${url.pathname}${url.search}${url.hash}`, agent, removedLegacySecrets: removedLegacy, changed };
}

export function peekAgentBootstrap() {
    return agentBootstrap;
}

export function clearAgentBootstrap() {
    agentBootstrap = null;
}

export function consumeLegacySecretNotice() {
    const value = removedLegacySecrets;
    removedLegacySecrets = false;
    return value;
}

function parseBootstrapFragment(hash: string) {
    const raw = hash.replace(/^#\??/, "");
    if (!raw || !raw.includes("=")) return null;
    const params = new URLSearchParams(raw);
    return [...params.keys()].some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) ? params : null;
}

function getParamIgnoreCase(params: URLSearchParams, expected: string) {
    const match = [...params.entries()].find(([key]) => key.toLowerCase() === expected.toLowerCase());
    return match?.[1] || "";
}

function isLoopbackAgentUrl(value: string) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
    } catch {
        return false;
    }
}
