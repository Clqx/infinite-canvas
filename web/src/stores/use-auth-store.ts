import { create } from "zustand";

import {
    credentialVault,
    clearLegacyCredentialStorage,
    createCredentialExport,
    createDefaultCredentialPayload,
    normalizeCredentialVaultPayload,
    openCredentialExport,
    readLegacyCredentialPayload,
    type CredentialVaultPayload,
} from "@/services/credential-vault";
import { defaultWebdavSyncConfig, useConfigStore } from "@/stores/use-config-store";
import { defaultPromptSourceSchedule, normalizePromptSourceState, usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useUserStore } from "@/stores/use-user-store";

export type AuthStatus = "booting" | "setup" | "locked" | "unlocking" | "unlocked" | "error";

type AuthStore = {
    status: AuthStatus;
    hasLegacyData: boolean;
    saving: boolean;
    saveError: string;
    initialize: () => Promise<void>;
    setup: (password: string) => Promise<void>;
    unlock: (password: string) => Promise<void>;
    lock: () => Promise<void>;
    changePassword: (newPassword: string) => Promise<void>;
    exportCredentials: (password: string) => Promise<string>;
    importCredentials: (password: string, input: string) => Promise<void>;
    resetCredentials: () => Promise<void>;
    flush: () => Promise<void>;
};

const SAVE_DELAY_MS = 300;
let initializePromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savePromise: Promise<void> = Promise.resolve();
let dirty = false;
let subscriptions: Array<() => void> = [];
let applyingPayload = false;

export const useAuthStore = create<AuthStore>((set, get) => ({
    status: "booting",
    hasLegacyData: false,
    saving: false,
    saveError: "",
    initialize: async () => {
        if (initializePromise) return initializePromise;
        set({ status: "booting", saveError: "" });
        initializePromise = (async () => {
            try {
                const [vaultState, legacy] = await Promise.all([credentialVault.inspect(), Promise.resolve(readLegacyCredentialPayload())]);
                set({ status: vaultState.hasActive ? "locked" : "setup", hasLegacyData: legacy.found, saveError: "" });
            } catch (error) {
                set({ status: "error", saveError: errorMessage(error, "无法读取本地凭据保险库") });
                initializePromise = null;
            }
        })();
        return initializePromise;
    },
    setup: async (password) => {
        assertPassword(password);
        set({ status: "unlocking", saveError: "" });
        try {
            const legacy = readLegacyCredentialPayload();
            const payload = await credentialVault.setup(password, legacy.payload);
            applyPayload(payload);
            clearLegacyCredentialStorage();
            startSubscriptions();
            set({ status: "unlocked", hasLegacyData: false });
        } catch (error) {
            set({ status: "setup", saveError: errorMessage(error, "无法创建凭据保险库") });
            throw error;
        }
    },
    unlock: async (password) => {
        set({ status: "unlocking", saveError: "" });
        try {
            const payload = await credentialVault.unlock(password);
            applyPayload(payload);
            clearLegacyCredentialStorage();
            startSubscriptions();
            set({ status: "unlocked", hasLegacyData: false });
        } catch (error) {
            set({ status: "locked", saveError: errorMessage(error, "密码错误或保险库已损坏") });
            throw error;
        }
    },
    lock: async () => {
        await get().flush();
        stopSubscriptions();
        await credentialVault.lock();
        clearSensitiveMemory();
        set({ status: "locked", saving: false, saveError: "" });
    },
    changePassword: async (newPassword) => {
        assertPassword(newPassword);
        await get().flush();
        const payload = currentPayload();
        await credentialVault.changePassword(newPassword, payload);
        set({ saveError: "" });
    },
    exportCredentials: async (password) => {
        assertPassword(password);
        await get().flush();
        return createCredentialExport(password, currentPayload());
    },
    importCredentials: async (password, input) => {
        assertPassword(password);
        const payload = await openCredentialExport(password, input);
        await get().flush();
        await credentialVault.update(payload);
        applyPayload(payload);
        set({ saveError: "" });
    },
    resetCredentials: async () => {
        await credentialVault.reset();
        stopSubscriptions();
        clearLegacyCredentialStorage();
        clearSensitiveMemory();
        initializePromise = null;
        set({ status: "setup", hasLegacyData: false, saving: false, saveError: "" });
    },
    flush: async () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        while (dirty || get().saving) {
            if (dirty) persistCurrentPayload();
            await savePromise;
            if (get().saveError) throw new Error(get().saveError);
        }
        await credentialVault.flush();
    },
}));

function startSubscriptions() {
    stopSubscriptions();
    subscriptions = [
        useConfigStore.subscribe((state, previous) => {
            if (state.config !== previous.config || state.webdav !== previous.webdav) scheduleSave();
        }),
        usePromptSourceStore.subscribe((state, previous) => {
            if (state.sources !== previous.sources || state.schedule !== previous.schedule) scheduleSave();
        }),
        useAgentStore.subscribe((state, previous) => {
            if (state.url !== previous.url || state.token !== previous.token) scheduleSave();
        }),
    ];
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", flushBeforePageExit);
    if (typeof window !== "undefined") window.addEventListener("pagehide", flushBeforePageExit);
}

function stopSubscriptions() {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    subscriptions = [];
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", flushBeforePageExit);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", flushBeforePageExit);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;
}

function flushBeforePageExit() {
    if (typeof document !== "undefined" && document.visibilityState !== "hidden") return;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    persistCurrentPayload();
}

function scheduleSave() {
    if (applyingPayload || useAuthStore.getState().status !== "unlocked") return;
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        persistCurrentPayload();
    }, SAVE_DELAY_MS);
}

function persistCurrentPayload() {
    if (!dirty || useAuthStore.getState().status !== "unlocked") return;
    if (useAuthStore.getState().saving) return;
    dirty = false;
    const payload = currentPayload();
    useAuthStore.setState({ saving: true, saveError: "" });
    savePromise = credentialVault.update(payload).then(
        () => {
            useAuthStore.setState({ saving: false });
            if (dirty) scheduleSave();
        },
        (error) => {
            dirty = true;
            useAuthStore.setState({ saving: false, saveError: errorMessage(error, "加密配置保存失败") });
        },
    );
}

function currentPayload(): CredentialVaultPayload {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const { url, token } = useAgentStore.getState();
    return normalizeCredentialVaultPayload({ schemaVersion: 1, config, webdav, promptSources: { sources, schedule }, agentConnection: { url, token } });
}

function applyPayload(payload: CredentialVaultPayload) {
    applyingPayload = true;
    try {
        useConfigStore.setState({ config: payload.config, webdav: payload.webdav });
        usePromptSourceStore.setState(payload.promptSources);
        useAgentStore.setState({ url: payload.agentConnection.url, token: payload.agentConnection.token, enabled: false, connected: false });
        useUserStore.getState().setSession({ id: "local", username: "local", displayName: "本地用户", avatarUrl: "" });
    } finally {
        applyingPayload = false;
    }
}

function clearSensitiveMemory() {
    applyingPayload = true;
    try {
        useAgentStore.getState().disconnectAgent({ url: "http://127.0.0.1:17371", token: "", messages: [], threads: [], activeThreadId: "", pendingTool: null, pendingApprovals: [] });
        useConfigStore.setState({ config: normalizeCredentialVaultPayload(createDefaultCredentialPayload()).config, webdav: defaultWebdavSyncConfig });
        usePromptSourceStore.setState(normalizePromptSourceState({ sources: [], schedule: defaultPromptSourceSchedule }));
        useUserStore.getState().clearSession();
    } finally {
        applyingPayload = false;
    }
}

function assertPassword(password: string) {
    if (password.length < 10) throw new Error("本地密码至少需要 10 个字符");
}

function errorMessage(error: unknown, fallback: string) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "DECRYPTION_FAILED") return "密码错误或加密数据已损坏";
    if (code === "CRYPTO_UNAVAILABLE") return "当前浏览器无法使用安全加密，请通过 localhost 或 HTTPS 打开";
    if (code === "IN_USE") return "凭据保险库已在另一个标签页解锁，请先锁定另一个标签页";
    return error instanceof Error && error.message ? error.message : fallback;
}
