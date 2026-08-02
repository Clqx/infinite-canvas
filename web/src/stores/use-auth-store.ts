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
import { flushAppDataPersistence, hydrateAppDataPersistence } from "@/services/app-data-persistence-actions";
import { defaultPromptSourceSchedule, normalizePromptSourceState, usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useUserStore } from "@/stores/use-user-store";
import {
    activateLocalUserProfile,
    assertLocalPassword,
    completeLocalUserActivation,
    createLocalUserProfile,
    deactivateLocalUserProfile,
    getLocalUserProfile,
    getRememberedLocalUserProfile,
    listLocalUserProfiles,
    registerLocalUserProfile,
    rememberActiveLocalUserProfile,
    subscribeLocalUserProfiles,
    verifyLocalUserActivation,
    type LocalUserProfile,
} from "@/services/local-user-profiles";

export type AuthStatus = "booting" | "account" | "setup" | "locked" | "unlocking" | "unlocked" | "error";

type AuthStore = {
    status: AuthStatus;
    profiles: LocalUserProfile[];
    profile: LocalUserProfile | null;
    hasLegacyData: boolean;
    saving: boolean;
    saveError: string;
    initialize: () => Promise<void>;
    setup: (username: string, password: string, activationCode?: string) => Promise<void>;
    unlock: (password: string) => Promise<void>;
    selectProfile: (profileId: string) => void;
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
let stopProfileSync: (() => void) | null = null;
let profileSyncPromise: Promise<void> = Promise.resolve();

export const useAuthStore = create<AuthStore>((set, get) => ({
    status: "booting",
    profiles: [],
    profile: null,
    hasLegacyData: false,
    saving: false,
    saveError: "",
    initialize: async () => {
        if (initializePromise) return initializePromise;
        startProfileSync();
        set({ status: "booting", saveError: "" });
        initializePromise = (async () => {
            try {
                const profiles = listLocalUserProfiles();
                const profile = getRememberedLocalUserProfile(profiles);
                if (!profile) {
                    set({ status: profiles.length ? "account" : "setup", profiles, profile: null, hasLegacyData: false, saveError: "" });
                    return;
                }
                activateLocalUserProfile(profile);
                rememberActiveLocalUserProfile(profile.id);
                const [vaultState, legacy] = await Promise.all([credentialVault.inspect(), Promise.resolve(readProfileLegacyCredentials(profile))]);
                set({ status: vaultState.hasActive ? "locked" : "setup", profiles, profile, hasLegacyData: legacy.found, saveError: "" });
            } catch (error) {
                set({ status: "error", saveError: errorMessage(error, "无法读取本地凭据保险库") });
                initializePromise = null;
            }
        })();
        return initializePromise;
    },
    setup: async (username, password, activationCode = "") => {
        assertLocalPassword(password);
        const existingProfile = get().profile;
        let profile = existingProfile || createLocalUserProfile(username, get().profiles.length === 0);
        if (!existingProfile && get().profiles.some((item) => item.id === profile.id)) throw new Error("该用户已存在，请直接选择后解锁");
        set({ status: "unlocking", saveError: "" });
        let createdVault = false;
        try {
            if (!existingProfile) await registerLocalUserProfile(profile);
            profile = getLocalUserProfile(profile.id) || profile;
            activateLocalUserProfile(profile);
            const legacy = readProfileLegacyCredentials(profile);
            const vaultState = await credentialVault.inspect();
            if (!vaultState.hasActive && !profile.legacyOwner) await verifyLocalUserActivation(profile, activationCode);
            const payload = vaultState.hasActive ? await credentialVault.unlock(password) : await credentialVault.setup(password, legacy.payload);
            createdVault = !vaultState.hasActive;
            applyPayload(payload, profile);
            await hydrateAppDataPersistence();
            clearProfileLegacyCredentials(profile);
            if (createdVault && profile.activation) profile = await completeLocalUserActivation(profile.id, activationCode);
            startSubscriptions();
            set({ status: "unlocked", profiles: listLocalUserProfiles(), profile, hasLegacyData: false });
        } catch (error) {
            if (credentialVault.isUnlocked()) {
                if (createdVault) await credentialVault.reset().catch(() => credentialVault.lock().catch(() => undefined));
                else await credentialVault.lock().catch(() => undefined);
            }
            clearSensitiveMemory();
            const profiles = listLocalUserProfiles();
            const storedProfile = profiles.find((item) => item.id === profile.id && item.status === "active") || null;
            if (storedProfile) activateLocalUserProfile(storedProfile);
            else deactivateLocalUserProfile();
            const hasActive = storedProfile
                ? await credentialVault.inspect().then(
                      (state) => state.hasActive,
                      () => false,
                  )
                : false;
            set({
                status: storedProfile ? (hasActive ? "locked" : "setup") : profiles.length ? "account" : "setup",
                profiles,
                profile: storedProfile,
                hasLegacyData: storedProfile ? readProfileLegacyCredentials(storedProfile).found : false,
                saveError: errorMessage(error, "无法创建用户保险库"),
            });
            throw error;
        }
    },
    unlock: async (password) => {
        set({ status: "unlocking", saveError: "" });
        try {
            const selected = get().profile;
            const profile = selected ? getLocalUserProfile(selected.id) : null;
            if (!profile) throw new Error("请先选择用户");
            activateLocalUserProfile(profile);
            const payload = await credentialVault.unlock(password);
            applyPayload(payload, profile);
            clearProfileLegacyCredentials(profile);
            await hydrateAppDataPersistence();
            startSubscriptions();
            set({ status: "unlocked", profiles: listLocalUserProfiles(), profile, hasLegacyData: false });
        } catch (error) {
            if (credentialVault.isUnlocked()) await credentialVault.lock().catch(() => undefined);
            clearSensitiveMemory();
            const profiles = listLocalUserProfiles();
            const selected = get().profile;
            const profile = selected ? profiles.find((item) => item.id === selected.id && item.status === "active") || null : null;
            if (!profile) deactivateLocalUserProfile();
            set({ status: profile ? "locked" : "account", profiles, profile, saveError: errorMessage(error, "密码错误或保险库已损坏") });
            throw error;
        }
    },
    selectProfile: (profileId) => {
        if (!get().profiles.some((profile) => profile.id === profileId && profile.status === "active")) return;
        rememberActiveLocalUserProfile(profileId);
        window.location.reload();
    },
    lock: async () => {
        await flushAppDataPersistence();
        await get().flush();
        stopSubscriptions();
        await credentialVault.lock();
        clearSensitiveMemory();
        const profiles = listLocalUserProfiles();
        const selected = get().profile;
        const profile = selected ? profiles.find((item) => item.id === selected.id && item.status === "active") || null : null;
        if (!profile) deactivateLocalUserProfile();
        set({ status: profile ? "locked" : "account", profiles, profile, saving: false, saveError: "" });
    },
    changePassword: async (newPassword) => {
        assertLocalPassword(newPassword);
        await get().flush();
        const payload = currentPayload();
        await credentialVault.changePassword(newPassword, payload);
        set({ saveError: "" });
    },
    exportCredentials: async (password) => {
        assertLocalPassword(password);
        await get().flush();
        return createCredentialExport(password, currentPayload());
    },
    importCredentials: async (password, input) => {
        const profile = get().profile;
        if (!profile) throw new Error("请先选择用户");
        assertLocalPassword(password);
        const payload = await openCredentialExport(password, input);
        await get().flush();
        await credentialVault.update(payload);
        applyPayload(payload, profile);
        set({ saveError: "" });
    },
    resetCredentials: async () => {
        const profile = get().profile;
        if (!profile) throw new Error("请先选择用户");
        if (get().status !== "unlocked" || !credentialVault.isUnlocked()) throw new Error("请先解锁当前用户，再重置凭据");
        await get().flush();
        const payload = normalizeCredentialVaultPayload(createDefaultCredentialPayload());
        await credentialVault.update(payload);
        applyPayload(payload, profile);
        clearProfileLegacyCredentials(profile);
        set({ hasLegacyData: false, saving: false, saveError: "" });
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

function startProfileSync() {
    if (stopProfileSync) return;
    stopProfileSync = subscribeLocalUserProfiles(() => {
        profileSyncPromise = profileSyncPromise.then(syncLocalProfiles, syncLocalProfiles);
    });
}

async function syncLocalProfiles() {
    const profiles = listLocalUserProfiles();
    const state = useAuthStore.getState();
    if (!state.profile) {
        useAuthStore.setState({ profiles, ...(state.status === "account" ? { saveError: "" } : {}) });
        return;
    }

    const profile = profiles.find((item) => item.id === state.profile?.id) || null;
    if (!profile || profile.status !== "active") {
        const flushResults = await Promise.allSettled([flushAppDataPersistence(), state.flush()]);
        stopSubscriptions();
        if (credentialVault.isUnlocked()) await credentialVault.lock().catch(() => undefined);
        clearSensitiveMemory();
        deactivateLocalUserProfile();
        useAuthStore.setState({
            status: "account",
            profiles,
            profile: null,
            saving: false,
            saveError: flushResults.some((result) => result.status === "rejected") ? "当前用户已停用，部分本地更改未能保存" : "当前用户已停用，请联系本机管理员",
        });
        return;
    }

    activateLocalUserProfile(profile);
    if (state.status === "unlocked") {
        useUserStore.getState().setSession({ id: profile.id, username: profile.username, displayName: profile.displayName, role: profile.role, avatarUrl: "" });
    }
    useAuthStore.setState({ profiles, profile });
}

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

function applyPayload(payload: CredentialVaultPayload, profile: LocalUserProfile) {
    applyingPayload = true;
    try {
        useConfigStore.setState({ config: payload.config, webdav: payload.webdav });
        usePromptSourceStore.setState(payload.promptSources);
        useAgentStore.setState({ url: payload.agentConnection.url, token: payload.agentConnection.token, enabled: false, connected: false });
        useUserStore.getState().setSession({ id: profile.id, username: profile.username, displayName: profile.displayName, role: profile.role, avatarUrl: "" });
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

function readProfileLegacyCredentials(profile: LocalUserProfile) {
    return readLegacyCredentialPayload(profile.legacyOwner ? undefined : null);
}

function clearProfileLegacyCredentials(profile: LocalUserProfile) {
    clearLegacyCredentialStorage(profile.legacyOwner ? undefined : null);
}

function errorMessage(error: unknown, fallback: string) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "DECRYPTION_FAILED") return "密码错误或加密数据已损坏";
    if (code === "CRYPTO_UNAVAILABLE") return "当前浏览器无法使用安全加密，请通过 localhost 或 HTTPS 打开";
    if (code === "IN_USE") return "凭据保险库已在另一个标签页解锁，请先锁定另一个标签页";
    return error instanceof Error && error.message ? error.message : fallback;
}
