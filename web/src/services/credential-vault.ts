import { openWithPassword, sealWithPassword, serializeCryptoEnvelope } from "@/lib/crypto-envelope";
import { parseAppConfig } from "@/services/config-file";
import { createLocalVault } from "@/services/local-vault";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { CONFIG_STORE_KEY, defaultConfig, defaultWebdavSyncConfig, normalizeAiConfig, normalizeWebdavConfig, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { PROMPT_SOURCE_STORE_KEY, defaultPromptSourceSchedule, normalizePromptSourceState, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";

const LEGACY_AGENT_URL_KEY = "canvas-agent-url";
const LEGACY_AGENT_TOKEN_KEY = "canvas-agent-token";

export type LegacyCredentialStorage = Pick<Storage, "getItem" | "removeItem">;
export const MAX_CREDENTIAL_BACKUP_BYTES = 6 * 1024 * 1024;

export type CredentialVaultPayload = {
    schemaVersion: 1;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
    agentConnection: {
        url: string;
        token: string;
    };
};

export const credentialVault = createLocalVault<CredentialVaultPayload>({ validatePayload: normalizeCredentialVaultPayload });

export function createDefaultCredentialPayload(): CredentialVaultPayload {
    return {
        schemaVersion: 1,
        config: normalizeAiConfig(defaultConfig),
        webdav: normalizeWebdavConfig(defaultWebdavSyncConfig),
        promptSources: normalizePromptSourceState({ sources: [], schedule: defaultPromptSourceSchedule }),
        agentConnection: { url: "http://127.0.0.1:17371", token: "" },
    };
}

export function readLegacyCredentialPayload(storage: LegacyCredentialStorage | null = browserStorage()) {
    const fallback = createDefaultCredentialPayload();
    if (!storage) return { payload: fallback, found: false };
    const configState = readZustandState(storage.getItem(CONFIG_STORE_KEY));
    const promptState = readZustandState(storage.getItem(PROMPT_SOURCE_STORE_KEY));
    const legacyUrl = storage.getItem(LEGACY_AGENT_URL_KEY);
    const legacyToken = storage.getItem(LEGACY_AGENT_TOKEN_KEY);
    const found = Boolean(configState || promptState || legacyUrl || legacyToken);
    return {
        found,
        payload: normalizeCredentialVaultPayload({
            ...fallback,
            config: configState?.config,
            webdav: configState?.webdav,
            promptSources: promptState,
            agentConnection: { url: legacyUrl || fallback.agentConnection.url, token: legacyToken || "" },
        }),
    };
}

export function clearLegacyCredentialStorage(storage: LegacyCredentialStorage | null = browserStorage()) {
    if (!storage) return;
    for (const key of [CONFIG_STORE_KEY, PROMPT_SOURCE_STORE_KEY, LEGACY_AGENT_URL_KEY, LEGACY_AGENT_TOKEN_KEY]) {
        try {
            storage.removeItem(key);
        } catch {
            // The encrypted write is already verified; stale plaintext cleanup is best effort.
        }
    }
}

export async function createCredentialExport(password: string, payload: CredentialVaultPayload) {
    return serializeCryptoEnvelope(await sealWithPassword(password, normalizeCredentialVaultPayload(payload), "config-export"));
}

export async function openCredentialExport(password: string, input: string) {
    return openWithPassword(password, input, "config-export", validateCredentialExportPayload);
}

export async function readCredentialExportFile(file: File) {
    if (file.size > MAX_CREDENTIAL_BACKUP_BYTES) throw new Error("加密凭据备份不能超过 6MB");
    return file.text();
}

export function normalizeCredentialVaultPayload(value: unknown): CredentialVaultPayload {
    if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("凭据保险库数据格式不正确");
    const promptSources = normalizePromptSourceState(value.promptSources);
    const connection = isRecord(value.agentConnection) ? value.agentConnection : {};
    return {
        schemaVersion: 1,
        config: normalizeAiConfig(value.config),
        webdav: normalizeWebdavConfig(value.webdav),
        promptSources,
        agentConnection: {
            url: typeof connection.url === "string" && connection.url.trim() ? connection.url.trim().replace(/\/$/, "") : "http://127.0.0.1:17371",
            token: typeof connection.token === "string" ? connection.token.trim() : "",
        },
    };
}

function readZustandState(raw: string | null) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) return null;
        return isRecord(parsed.state) ? parsed.state : parsed;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateCredentialExportPayload(value: unknown): CredentialVaultPayload {
    if (!isStrictRecord(value, ["schemaVersion", "config", "webdav", "promptSources", "agentConnection"]) || value.schemaVersion !== 1) throw new Error("凭据备份数据格式不正确");
    if (!isStrictRecord(value.agentConnection, ["url", "token"]) || typeof value.agentConnection.url !== "string" || typeof value.agentConnection.token !== "string" || value.agentConnection.url.length > 4096 || value.agentConnection.token.length > 4096) {
        throw new Error("凭据备份数据格式不正确");
    }
    const parsed = parseAppConfig(
        JSON.stringify({
            app: "infinite-canvas",
            version: 2,
            exportedAt: "1970-01-01T00:00:00.000Z",
            includesSecrets: true,
            config: value.config,
            webdav: value.webdav,
            promptSources: value.promptSources,
        }),
    );
    return {
        schemaVersion: 1,
        config: parsed.data.config,
        webdav: parsed.data.webdav,
        promptSources: parsed.data.promptSources,
        agentConnection: { url: value.agentConnection.url.trim().replace(/\/$/, "") || "http://127.0.0.1:17371", token: value.agentConnection.token.trim() },
    };
}

function isStrictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return isRecord(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function browserStorage() {
    return typeof window === "undefined" ? null : window.localStorage;
}
