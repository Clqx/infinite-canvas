import localforage from "localforage";

const PROFILE_STORE_KEY = "infinite-canvas:user-profiles:v1";
const ACTIVE_PROFILE_KEY = "infinite-canvas:active-user-profile:v1";
const PROFILE_LOCK_NAME = "infinite-canvas:user-profiles-write:v1";
const PROFILE_SYNC_CHANNEL = "infinite-canvas:user-profiles-sync:v1";
export const MIN_LOCAL_PASSWORD_LENGTH = 10;

export type LocalUserRole = "admin" | "user";
export type LocalUserStatus = "active" | "disabled";
export type LocalUserActivation = {
    salt: string;
    hash: string;
    createdAt: string;
};
export type LocalUserProfile = {
    id: string;
    username: string;
    displayName: string;
    role: LocalUserRole;
    status: LocalUserStatus;
    legacyOwner: boolean;
    activation?: LocalUserActivation;
    activatedAt?: string;
};
export type ProvisionedLocalUser = {
    profile: LocalUserProfile;
    activationCode: string;
};

type ProfileStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type StoredProfiles = { version: number; profiles: LocalUserProfile[] };

let activeProfile: LocalUserProfile | null = null;
let profileMutationTail: Promise<unknown> = Promise.resolve();

export function normalizeLocalUsername(value: string) {
    const username = value.trim().normalize("NFKC");
    if (!username) throw new Error("请输入用户名");
    if (Array.from(username).length > 32) throw new Error("用户名不能超过 32 个字符");
    if (/[\u0000-\u001f\u007f]/.test(username)) throw new Error("用户名包含不可用字符");
    return username;
}

export function assertLocalPassword(password: string) {
    if (password.length < MIN_LOCAL_PASSWORD_LENGTH) throw new Error(`本地密码至少需要 ${MIN_LOCAL_PASSWORD_LENGTH} 个字符`);
}

export function createLocalUserProfile(username: string, legacyOwner = false, role: LocalUserRole = legacyOwner ? "admin" : "user"): LocalUserProfile {
    const normalized = normalizeLocalUsername(username);
    const canonical = normalized.toLocaleLowerCase("zh-CN");
    const id = `user-${Array.from(new TextEncoder().encode(canonical), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return { id, username: normalized, displayName: normalized, role, status: "active", legacyOwner };
}

export function listLocalUserProfiles(storage: ProfileStorage | null = browserLocalStorage()): LocalUserProfile[] {
    return readStoredProfiles(storage).profiles;
}

export function getLocalUserProfile(profileId: string, storage: ProfileStorage | null = browserLocalStorage()) {
    return listLocalUserProfiles(storage).find((profile) => profile.id === profileId) || null;
}

export async function registerLocalUserProfile(profile: LocalUserProfile, storage: ProfileStorage | null = browserLocalStorage()) {
    return mutateProfiles(storage, (profiles) => {
        if (profiles.some((item) => item.id === profile.id)) throw new Error("该用户已存在，请直接选择后解锁");
        if (profile.legacyOwner && profiles.length > 0) throw new Error("本机管理员已由另一个页面创建，请重新选择用户");
        return { profiles: [...profiles, profile], result: profile };
    }).then((saved) => {
        rememberActiveLocalUserProfile(saved.id, storage);
        return saved;
    });
}

export async function provisionLocalUserProfile(actorId: string, username: string, role: LocalUserRole, storage: ProfileStorage | null = browserLocalStorage()): Promise<ProvisionedLocalUser> {
    const activationCode = createActivationCode();
    const activation = await createActivation(activationCode);
    return mutateProfiles(storage, (profiles) => {
        requireActiveAdmin(profiles, actorId);
        const profile = { ...createLocalUserProfile(username, false, role), activation };
        if (profiles.some((item) => item.id === profile.id)) throw new Error("该用户已存在");
        return { profiles: [...profiles, profile], result: { profile, activationCode } };
    });
}

export async function issueLocalUserActivation(actorId: string, profileId: string, storage: ProfileStorage | null = browserLocalStorage()): Promise<ProvisionedLocalUser> {
    const activationCode = createActivationCode();
    const activation = await createActivation(activationCode);
    return mutateProfiles(storage, (profiles) => {
        requireActiveAdmin(profiles, actorId);
        const target = profiles.find((profile) => profile.id === profileId);
        if (!target) throw new Error("用户不存在");
        if (target.id === actorId) throw new Error("不能为当前用户生成激活码");
        if (target.legacyOwner) throw new Error("首位本机管理员不使用激活码");
        if (target.status !== "active") throw new Error("请先启用该用户");
        if (target.activatedAt) throw new Error("该用户已完成激活");
        const profile = { ...target, activation };
        return { profiles: profiles.map((item) => (item.id === profileId ? profile : item)), result: { profile, activationCode } };
    });
}

export async function verifyLocalUserActivation(profile: LocalUserProfile, activationCode: string) {
    if (!profile.activation) throw new Error("该本机用户需要管理员生成激活码");
    const actual = await activationHash(profile.activation.salt, activationCode);
    if (!constantTimeEqual(actual, profile.activation.hash)) throw new Error("激活码无效");
}

export async function completeLocalUserActivation(profileId: string, activationCode: string, storage: ProfileStorage | null = browserLocalStorage()) {
    return mutateProfiles(storage, async (profiles) => {
        const target = profiles.find((profile) => profile.id === profileId);
        if (!target) throw new Error("用户不存在");
        if (target.status !== "active") throw new Error("该用户已停用");
        await verifyLocalUserActivation(target, activationCode);
        const { activation: _activation, ...activatedProfile } = target;
        const profile: LocalUserProfile = { ...activatedProfile, activatedAt: new Date().toISOString() };
        return { profiles: profiles.map((item) => (item.id === profileId ? profile : item)), result: profile };
    });
}

export async function updateLocalUserProfile(actorId: string, profileId: string, patch: Partial<Pick<LocalUserProfile, "role" | "status">>, storage: ProfileStorage | null = browserLocalStorage()) {
    return mutateProfiles(storage, (profiles) => {
        requireActiveAdmin(profiles, actorId);
        const target = profiles.find((profile) => profile.id === profileId);
        if (!target) throw new Error("用户不存在");
        if (target.id === actorId && ((patch.role && patch.role !== "admin") || patch.status === "disabled")) throw new Error("不能移除或停用当前管理员");
        const nextTarget = { ...target, ...patch };
        const next = profiles.map((profile) => (profile.id === profileId ? nextTarget : profile));
        if (!next.some((profile) => profile.role === "admin" && profile.status === "active")) throw new Error("至少需要保留一名启用的管理员");
        return { profiles: next, result: nextTarget };
    });
}

export function activateLocalUserProfile(profile: LocalUserProfile) {
    if (profile.status !== "active") throw new Error("该用户已停用");
    activeProfile = profile;
}

export function deactivateLocalUserProfile() {
    activeProfile = null;
}

export function getActiveLocalUserProfile() {
    return activeProfile;
}

export function requireActiveLocalUserProfile() {
    if (!activeProfile) throw new Error("请先选择用户");
    return activeProfile;
}

export function getRememberedLocalUserProfile(profiles = listLocalUserProfiles(), storage: ProfileStorage | null = browserLocalStorage()) {
    const id = storage?.getItem(ACTIVE_PROFILE_KEY) || "";
    const remembered = profiles.find((profile) => profile.id === id && profile.status === "active");
    if (remembered) return remembered;
    const activeProfiles = profiles.filter((profile) => profile.status === "active");
    return activeProfiles.length === 1 ? activeProfiles[0] : null;
}

export function rememberActiveLocalUserProfile(profileId: string, storage: ProfileStorage | null = browserLocalStorage()) {
    storage?.setItem(ACTIVE_PROFILE_KEY, profileId);
}

export function subscribeLocalUserProfiles(listener: () => void) {
    if (typeof window === "undefined") return () => undefined;
    const onStorage = (event: StorageEvent) => {
        if (event.key === PROFILE_STORE_KEY) listener();
    };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(PROFILE_SYNC_CHANNEL);
    const onMessage = () => listener();
    window.addEventListener("storage", onStorage);
    channel?.addEventListener("message", onMessage);
    return () => {
        window.removeEventListener("storage", onStorage);
        channel?.removeEventListener("message", onMessage);
        channel?.close();
    };
}

export function userScopedDatabaseName(baseName: string) {
    const profile = requireActiveLocalUserProfile();
    return profile.legacyOwner ? baseName : `${baseName}--${profile.id}`;
}

export function userScopedResourceName(baseName: string) {
    return `${baseName}:${requireActiveLocalUserProfile().id}`;
}

export function createUserScopedLocalForage(options: LocalForageOptions): LocalForage {
    const stores = new Map<string, LocalForage>();
    const resolve = () => {
        const name = userScopedDatabaseName(options.name || "localforage");
        let store = stores.get(name);
        if (!store) {
            store = localforage.createInstance({ ...options, name, driver: options.driver || localforage.INDEXEDDB });
            stores.set(name, store);
        }
        return store;
    };

    return new Proxy({} as LocalForage, {
        get(_target, property) {
            const store = resolve();
            const value = Reflect.get(store, property, store) as unknown;
            return typeof value === "function" ? value.bind(store) : value;
        },
    });
}

function requireActiveAdmin(profiles: LocalUserProfile[], actorId: string) {
    const actor = profiles.find((profile) => profile.id === actorId);
    if (!actor || actor.role !== "admin" || actor.status !== "active" || (!actor.legacyOwner && !actor.activatedAt)) throw new Error("只有已激活的管理员可以管理用户");
}

async function mutateProfiles<R>(storage: ProfileStorage | null, mutation: (profiles: LocalUserProfile[]) => { profiles: LocalUserProfile[]; result: R } | Promise<{ profiles: LocalUserProfile[]; result: R }>) {
    if (!storage) throw new Error("当前浏览器无法保存本地用户");
    return withProfileWriteLock(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = readStoredProfiles(storage);
            const next = await mutation(current.profiles);
            if (readStoredProfiles(storage).version !== current.version) continue;
            storage.setItem(PROFILE_STORE_KEY, JSON.stringify({ version: current.version + 1, profiles: next.profiles } satisfies StoredProfiles));
            notifyProfileChange(storage, current.version + 1);
            return next.result;
        }
        throw new Error("用户档案已在其他页面更新，请重试");
    });
}

function withProfileWriteLock<R>(operation: () => Promise<R>) {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(PROFILE_LOCK_NAME, { mode: "exclusive" }, operation);
    const run = profileMutationTail.then(operation, operation);
    profileMutationTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function readStoredProfiles(storage: ProfileStorage | null): StoredProfiles {
    if (!storage) return { version: 0, profiles: [] };
    try {
        const value = JSON.parse(storage.getItem(PROFILE_STORE_KEY) || "[]") as unknown;
        const version = value && typeof value === "object" && !Array.isArray(value) && Number.isSafeInteger((value as Record<string, unknown>).version) ? Math.max(0, Number((value as Record<string, unknown>).version)) : 0;
        const rawProfiles: unknown[] = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).profiles) ? ((value as Record<string, unknown>).profiles as unknown[]) : [];
        return {
            version,
            profiles: rawProfiles.flatMap((item, index) => {
                const profile = normalizeStoredProfile(item, index);
                return profile ? [profile] : [];
            }),
        };
    } catch {
        return { version: 0, profiles: [] };
    }
}

function notifyProfileChange(storage: ProfileStorage, version: number) {
    if (typeof window === "undefined" || storage !== window.localStorage || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(PROFILE_SYNC_CHANNEL);
    channel.postMessage({ version });
    channel.close();
}

function browserLocalStorage(): ProfileStorage | null {
    return typeof window === "undefined" ? null : window.localStorage;
}

function normalizeStoredProfile(value: unknown, index: number): LocalUserProfile | null {
    if (!value || typeof value !== "object") return null;
    const profile = value as Record<string, unknown>;
    if (typeof profile.id !== "string" || !/^user-[a-f0-9]+$/.test(profile.id) || typeof profile.username !== "string" || !profile.username || typeof profile.displayName !== "string" || typeof profile.legacyOwner !== "boolean") return null;
    const activation = normalizeActivation(profile.activation);
    return {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        role: profile.role === "admin" || profile.role === "user" ? profile.role : index === 0 ? "admin" : "user",
        status: profile.status === "disabled" ? "disabled" : "active",
        legacyOwner: profile.legacyOwner,
        ...(activation ? { activation } : {}),
        ...(typeof profile.activatedAt === "string" ? { activatedAt: profile.activatedAt } : {}),
    };
}

function normalizeActivation(value: unknown): LocalUserActivation | null {
    if (!value || typeof value !== "object") return null;
    const activation = value as Record<string, unknown>;
    if (typeof activation.salt !== "string" || !/^[a-f0-9]{32}$/.test(activation.salt) || typeof activation.hash !== "string" || !/^[a-f0-9]{64}$/.test(activation.hash) || typeof activation.createdAt !== "string") return null;
    return { salt: activation.salt, hash: activation.hash, createdAt: activation.createdAt };
}

function createActivationCode() {
    const bytes = new Uint8Array(16);
    requireCrypto().getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{1,4}/g)!.join("-");
}

async function createActivation(activationCode: string): Promise<LocalUserActivation> {
    const bytes = new Uint8Array(16);
    requireCrypto().getRandomValues(bytes);
    const salt = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { salt, hash: await activationHash(salt, activationCode), createdAt: new Date().toISOString() };
}

async function activationHash(salt: string, activationCode: string) {
    const normalized = activationCode.trim().replace(/[\s-]/g, "").toUpperCase();
    const digest = await requireCrypto().subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${normalized}`));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireCrypto() {
    if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle) throw new Error("当前环境无法生成本地用户激活凭证");
    return globalThis.crypto;
}

function constantTimeEqual(left: string, right: string) {
    if (left.length !== right.length) return false;
    let different = 0;
    for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return different === 0;
}
