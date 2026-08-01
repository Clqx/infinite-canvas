import { saveAs } from "file-saver";

import type { PromptSource } from "@/services/api/prompt-source-presets";
import { defaultConfig, defaultWebdavSyncConfig, normalizeAiConfig, normalizeWebdavConfig, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { defaultPromptSourceSchedule, normalizePromptSourceState, usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";

const MAX_CONFIG_BYTES = 1024 * 1024;
const APP_KEYS = ["app", "version", "exportedAt", "includesSecrets", "config", "webdav", "promptSources"] as const;
const AI_KEYS = Object.keys(defaultConfig);
const WEBDAV_KEYS = Object.keys(defaultWebdavSyncConfig);
const CHANNEL_KEYS = ["id", "name", "baseUrl", "apiKey", "apiFormat", "models"] as const;
const MODEL_KEYS = ["name", "capability", "script"] as const;
const PROMPT_STATE_KEYS = ["sources", "schedule"] as const;
const PROMPT_SOURCE_KEYS = ["id", "name", "url", "homepage", "enabled", "builtIn"] as const;
const PROMPT_SCHEDULE_KEYS = Object.keys(defaultPromptSourceSchedule);

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1 | 2;
    exportedAt: string;
    includesSecrets?: boolean;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export type ParsedAppConfig = {
    data: AppConfigFile;
    hasPlaintextSensitiveData: boolean;
};

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = {
        app: "infinite-canvas",
        version: 2,
        exportedAt: new Date().toISOString(),
        includesSecrets: false,
        config: {
            ...config,
            apiKey: "",
            channels: config.channels.map((channel) => ({ ...channel, apiKey: "", models: channel.models.map(({ script: _script, ...model }) => model) })),
        },
        webdav: { ...webdav, username: "", password: "" },
        promptSources: { sources, schedule },
    };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function readAppConfig(file: File) {
    if (file.size > MAX_CONFIG_BYTES) throw new Error("配置文件不能超过 1MB");
    return parseAppConfig(await file.text());
}

export function parseAppConfig(input: string): ParsedAppConfig {
    if (new TextEncoder().encode(input).byteLength > MAX_CONFIG_BYTES) throw new Error("配置文件不能超过 1MB");
    let value: unknown;
    try {
        value = JSON.parse(input) as unknown;
    } catch {
        throw new Error("配置文件格式不正确");
    }
    try {
        const root = strictRecord(value, APP_KEYS);
        if (root.app !== "infinite-canvas" || (root.version !== 1 && root.version !== 2)) invalidConfig();
        if (typeof root.exportedAt !== "string" || !Number.isFinite(Date.parse(root.exportedAt))) invalidConfig();
        if (root.includesSecrets !== undefined && typeof root.includesSecrets !== "boolean") invalidConfig();

        const rawConfig = validateAiConfig(root.config);
        const rawWebdav = validateWebdavConfig(root.webdav);
        const rawPromptSources = validatePromptSources(root.promptSources);
        const config = normalizeAiConfig(rawConfig);
        const webdav = normalizeWebdavConfig(rawWebdav);
        const promptSources = normalizePromptSourceState(rawPromptSources);
        const hasPlaintextSensitiveData = Boolean(config.apiKey.trim() || config.channels.some((channel) => channel.apiKey.trim() || channel.models.some((model) => model.script?.trim())) || webdav.username.trim() || webdav.password.trim());
        return {
            hasPlaintextSensitiveData,
            data: {
                app: "infinite-canvas",
                version: root.version,
                exportedAt: root.exportedAt,
                includesSecrets: hasPlaintextSensitiveData,
                config,
                webdav,
                promptSources,
            },
        };
    } catch (error) {
        if (error instanceof Error && error.message === "配置文件不能超过 1MB") throw error;
        throw new Error("配置文件格式不正确");
    }
}

export function applyAppConfig(data: AppConfigFile) {
    useConfigStore.setState({ config: data.config, webdav: data.webdav });
    usePromptSourceStore.setState(data.promptSources);
}

function validateAiConfig(value: unknown) {
    const config = strictRecord(value, AI_KEYS);
    for (const [key, item] of Object.entries(config)) {
        if (key === "channels" || key === "models") continue;
        if (typeof item !== "string" || item.length > 16_384) invalidConfig();
    }
    if (config.models !== undefined && (!Array.isArray(config.models) || config.models.length > 500 || config.models.some((model) => typeof model !== "string" || model.length > 512))) invalidConfig();
    if (config.channels !== undefined) {
        if (!Array.isArray(config.channels) || config.channels.length > 50) invalidConfig();
        config.channels = config.channels.map((value) => {
            const channel = strictRecord(value, CHANNEL_KEYS);
            for (const key of ["id", "name", "baseUrl", "apiKey"] as const) {
                if (typeof channel[key] !== "string" || channel[key].length > 4096) invalidConfig();
            }
            if (!(["openai", "gemini", "ark"] as unknown[]).includes(channel.apiFormat)) invalidConfig();
            if (!Array.isArray(channel.models) || channel.models.length > 100) invalidConfig();
            channel.models = channel.models.map((value) => {
                const model = strictRecord(value, MODEL_KEYS);
                if (typeof model.name !== "string" || model.name.length > 512 || !(["image", "video", "text", "audio"] as unknown[]).includes(model.capability)) invalidConfig();
                if (model.script !== undefined && (typeof model.script !== "string" || model.script.length > 64 * 1024)) invalidConfig();
                return model;
            });
            return channel;
        });
    }
    return config;
}

function validateWebdavConfig(value: unknown) {
    const webdav = strictRecord(value, WEBDAV_KEYS);
    for (const item of Object.values(webdav)) {
        if (typeof item !== "string" || item.length > 16_384) invalidConfig();
    }
    return webdav;
}

function validatePromptSources(value: unknown) {
    const state = strictRecord(value, PROMPT_STATE_KEYS);
    if (!Array.isArray(state.sources) || state.sources.length > 100) invalidConfig();
    state.sources = state.sources.map((value) => {
        const source = strictRecord(value, PROMPT_SOURCE_KEYS);
        for (const key of ["id", "name", "url", "homepage"] as const) {
            if (typeof source[key] !== "string" || source[key].length > 4096) invalidConfig();
        }
        if (typeof source.enabled !== "boolean" || typeof source.builtIn !== "boolean") invalidConfig();
        return source;
    });
    const schedule = strictRecord(state.schedule, PROMPT_SCHEDULE_KEYS);
    if (!Number.isInteger(schedule.intervalMinutes) || Number(schedule.intervalMinutes) < 0 || Number(schedule.intervalMinutes) > 7 * 24 * 60 || typeof schedule.lastFetchedAt !== "string" || schedule.lastFetchedAt.length > 128) invalidConfig();
    state.schedule = schedule;
    return state;
}

function strictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalidConfig();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowedKeys.includes(key))) invalidConfig();
    return record;
}

function invalidConfig(): never {
    throw new Error("配置文件格式不正确");
}
