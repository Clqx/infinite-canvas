import { CryptoEnvelopeError, createEnvelopeSession, parseCryptoEnvelope, serializeCryptoEnvelope, unlockEnvelopeSession, type EnvelopeSession } from "@/lib/crypto-envelope";
import { createUserScopedLocalForage, userScopedResourceName } from "@/services/local-user-profiles";

export const LOCAL_VAULT_ACTIVE_KEY = "active";
export const LOCAL_VAULT_PENDING_KEY = "pending";
export const LOCAL_VAULT_LOCK_NAME = "infinite-canvas:local-vault-session";

export type LocalVaultStorage = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
};

export type LocalVaultSessionLock = {
    acquire: () => Promise<() => void | Promise<void>>;
};

export type LocalVaultErrorCode = "ALREADY_SETUP" | "NOT_SETUP" | "ALREADY_UNLOCKED" | "LOCKED" | "IN_USE" | "INVALID_PAYLOAD" | "STORAGE_ERROR" | "VERIFICATION_FAILED";

export class LocalVaultError extends Error {
    readonly code: LocalVaultErrorCode;

    constructor(code: LocalVaultErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "LocalVaultError";
        this.code = code;
    }
}

export type LocalVaultBackup = {
    app: "infinite-canvas";
    kind: "local-vault-raw-backup";
    version: 1;
    exportedAt: string;
    active: string | null;
    pending: string | null;
};

export type LocalVault<T> = {
    inspect: () => Promise<{ hasActive: boolean; hasPending: boolean }>;
    isUnlocked: () => boolean;
    setup: (password: string, payload: T) => Promise<T>;
    unlock: (password: string) => Promise<T>;
    lock: () => Promise<void>;
    read: () => T;
    update: (payload: T) => Promise<T>;
    flush: () => Promise<void>;
    changePassword: (newPassword: string, payload?: T) => Promise<T>;
    reset: () => Promise<void>;
    rawBackup: () => Promise<LocalVaultBackup>;
};

export type LocalVaultOptions<T> = {
    validatePayload: (value: unknown) => T;
    storage?: LocalVaultStorage;
    sessionLock?: LocalVaultSessionLock;
};

const localVaultStore = createUserScopedLocalForage({ name: "infinite-canvas", storeName: "secure_vault" });

export const localForageVaultStorage: LocalVaultStorage = {
    async getItem(key) {
        const value = await localVaultStore.getItem<unknown>(key);
        if (value === null) return null;
        if (typeof value !== "string") throw new LocalVaultError("STORAGE_ERROR", `Vault storage value '${key}' is not a string`);
        return value;
    },
    async setItem(key, value) {
        await localVaultStore.setItem(key, value);
    },
    async removeItem(key) {
        await localVaultStore.removeItem(key);
    },
};

export function createLocalVault<T>(options: LocalVaultOptions<T>): LocalVault<T> {
    const storage = options.storage || localForageVaultStorage;
    const sessionLock = options.sessionLock || webLockSession;
    let cryptoSession: EnvelopeSession | null = null;
    let currentPayload: T | null = null;
    let releaseSessionLock: (() => void | Promise<void>) | null = null;
    let opening = false;
    let writeTail: Promise<void> = Promise.resolve();
    let latestWrite: Promise<unknown> = Promise.resolve();

    const validateAndClone = (value: unknown): T => {
        try {
            const serialized = JSON.stringify(value);
            if (serialized === undefined) throw new Error("Payload is not JSON serializable");
            return options.validatePayload(JSON.parse(serialized) as unknown);
        } catch (error) {
            if (error instanceof CryptoEnvelopeError) throw error;
            throw new LocalVaultError("INVALID_PAYLOAD", "Vault payload schema is invalid", { cause: error });
        }
    };

    const cloneCurrent = () => {
        if (!cryptoSession || currentPayload === null) throw new LocalVaultError("LOCKED", "Vault is locked");
        return validateAndClone(currentPayload);
    };

    const readStored = async (key: string) => {
        try {
            return await storage.getItem(key);
        } catch (error) {
            if (error instanceof LocalVaultError) throw error;
            throw new LocalVaultError("STORAGE_ERROR", `Unable to read vault storage '${key}'`, { cause: error });
        }
    };

    const setStored = async (key: string, value: string) => {
        try {
            await storage.setItem(key, value);
        } catch (error) {
            throw new LocalVaultError("STORAGE_ERROR", `Unable to write vault storage '${key}'`, { cause: error });
        }
    };

    const removeStored = async (key: string) => {
        try {
            await storage.removeItem(key);
        } catch (error) {
            throw new LocalVaultError("STORAGE_ERROR", `Unable to remove vault storage '${key}'`, { cause: error });
        }
    };

    const verifyStoredPayload = async (raw: string | null, expected: T, session: EnvelopeSession) => {
        if (raw === null) throw new LocalVaultError("VERIFICATION_FAILED", "Vault write verification could not read encrypted data");
        const verified = await session.open(raw, "local-vault", options.validatePayload);
        if (canonicalJson(verified) !== canonicalJson(expected)) throw new LocalVaultError("VERIFICATION_FAILED", "Vault write verification returned different data");
        return validateAndClone(verified);
    };

    const commit = async (payload: T, session: EnvelopeSession) => {
        const canonical = validateAndClone(payload);
        const pendingEnvelope = await session.seal(canonical, "local-vault");
        const pendingRaw = serializeCryptoEnvelope(pendingEnvelope);
        const previousActiveRaw = await readStored(LOCAL_VAULT_ACTIVE_KEY);

        await setStored(LOCAL_VAULT_PENDING_KEY, pendingRaw);
        const verifiedPending = await verifyStoredPayload(await readStored(LOCAL_VAULT_PENDING_KEY), canonical, session);
        try {
            await setStored(LOCAL_VAULT_ACTIVE_KEY, pendingRaw);
        } catch (writeError) {
            const activeAfterError = await readStored(LOCAL_VAULT_ACTIVE_KEY).catch(() => null);
            if (activeAfterError !== pendingRaw) throw writeError;
        }

        let verifiedActive: T;
        try {
            verifiedActive = await verifyStoredPayload(await readStored(LOCAL_VAULT_ACTIVE_KEY), verifiedPending, session);
        } catch (error) {
            await restoreActive(previousActiveRaw);
            throw error;
        }

        try {
            await removeStored(LOCAL_VAULT_PENDING_KEY);
        } catch {
            // A verified active value is authoritative; stale pending data is harmless and can be replaced by the next write.
        }
        return verifiedActive;
    };

    const restoreActive = async (previousActiveRaw: string | null) => {
        if (previousActiveRaw === null) await removeStored(LOCAL_VAULT_ACTIVE_KEY);
        else await setStored(LOCAL_VAULT_ACTIVE_KEY, previousActiveRaw);
        if ((await readStored(LOCAL_VAULT_ACTIVE_KEY)) !== previousActiveRaw) throw new LocalVaultError("VERIFICATION_FAILED", "Unable to restore the previous active vault after a failed commit");
    };

    const enqueue = <R>(operation: () => Promise<R>) => {
        const queued = writeTail.then(operation);
        writeTail = queued.then(
            () => undefined,
            () => undefined,
        );
        latestWrite = queued;
        return queued;
    };

    const releaseLock = async () => {
        const release = releaseSessionLock;
        releaseSessionLock = null;
        if (release) await release();
    };

    const clearSession = () => {
        cryptoSession = null;
        currentPayload = null;
    };

    return {
        async inspect() {
            const [active, pending] = await Promise.all([readStored(LOCAL_VAULT_ACTIVE_KEY), readStored(LOCAL_VAULT_PENDING_KEY)]);
            return { hasActive: active !== null, hasPending: pending !== null };
        },
        isUnlocked() {
            return cryptoSession !== null;
        },
        async setup(password, payload) {
            if (cryptoSession || opening) throw new LocalVaultError("ALREADY_UNLOCKED", "Vault is already unlocked");
            opening = true;
            let release: (() => void | Promise<void>) | null = null;
            try {
                release = await sessionLock.acquire();
                if ((await readStored(LOCAL_VAULT_ACTIVE_KEY)) !== null) throw new LocalVaultError("ALREADY_SETUP", "Vault has already been created");
                const canonical = validateAndClone(payload);
                const nextSession = await createEnvelopeSession(password);
                const saved = await commit(canonical, nextSession);
                cryptoSession = nextSession;
                currentPayload = saved;
                releaseSessionLock = release;
                release = null;
                return validateAndClone(saved);
            } finally {
                opening = false;
                if (release) await release();
            }
        },
        async unlock(password) {
            if (cryptoSession || opening) throw new LocalVaultError("ALREADY_UNLOCKED", "Vault is already unlocked");
            opening = true;
            let release: (() => void | Promise<void>) | null = null;
            try {
                release = await sessionLock.acquire();
                const activeRaw = await readStored(LOCAL_VAULT_ACTIVE_KEY);
                if (activeRaw === null) throw new LocalVaultError("NOT_SETUP", "Vault has not been created");
                const envelope = parseCryptoEnvelope(activeRaw, "local-vault");
                const unlocked = await unlockEnvelopeSession(password, envelope, "local-vault", options.validatePayload);
                const canonical = validateAndClone(unlocked.value);
                cryptoSession = unlocked.session;
                currentPayload = canonical;
                releaseSessionLock = release;
                release = null;
                return validateAndClone(canonical);
            } finally {
                opening = false;
                if (release) await release();
            }
        },
        async lock() {
            if (!cryptoSession) return;
            await latestWrite;
            clearSession();
            await releaseLock();
        },
        read() {
            return cloneCurrent();
        },
        update(payload) {
            if (!cryptoSession) return Promise.reject(new LocalVaultError("LOCKED", "Vault is locked"));
            const canonical = validateAndClone(payload);
            return enqueue(async () => {
                const activeSession = cryptoSession;
                if (!activeSession) throw new LocalVaultError("LOCKED", "Vault is locked");
                const saved = await commit(canonical, activeSession);
                currentPayload = saved;
                return validateAndClone(saved);
            });
        },
        async flush() {
            await latestWrite;
        },
        changePassword(newPassword, payload) {
            if (!cryptoSession) return Promise.reject(new LocalVaultError("LOCKED", "Vault is locked"));
            const canonical = payload === undefined ? cloneCurrent() : validateAndClone(payload);
            return enqueue(async () => {
                if (!cryptoSession) throw new LocalVaultError("LOCKED", "Vault is locked");
                const nextSession = await createEnvelopeSession(newPassword);
                const saved = await commit(canonical, nextSession);
                cryptoSession = nextSession;
                currentPayload = saved;
                return validateAndClone(saved);
            });
        },
        async reset() {
            if (cryptoSession) {
                await enqueue(async () => {
                    await removeStored(LOCAL_VAULT_PENDING_KEY);
                    await removeStored(LOCAL_VAULT_ACTIVE_KEY);
                    clearSession();
                });
                await releaseLock();
                return;
            }

            const release = await sessionLock.acquire();
            try {
                await removeStored(LOCAL_VAULT_PENDING_KEY);
                await removeStored(LOCAL_VAULT_ACTIVE_KEY);
            } finally {
                await release();
            }
        },
        async rawBackup() {
            const [active, pending] = await Promise.all([readStored(LOCAL_VAULT_ACTIVE_KEY), readStored(LOCAL_VAULT_PENDING_KEY)]);
            return { app: "infinite-canvas", kind: "local-vault-raw-backup", version: 1, exportedAt: new Date().toISOString(), active, pending };
        },
    };
}

const webLockSession: LocalVaultSessionLock = {
    async acquire() {
        if (typeof navigator === "undefined" || !navigator.locks) return () => undefined;

        let releaseHold: (() => void) | null = null;
        let settleAcquired: ((release: () => Promise<void>) => void) | null = null;
        let rejectAcquired: ((error: unknown) => void) | null = null;
        const acquired = new Promise<() => Promise<void>>((resolve, reject) => {
            settleAcquired = resolve;
            rejectAcquired = reject;
        });
        const hold = new Promise<void>((resolve) => {
            releaseHold = resolve;
        });
        const request = navigator.locks.request(userScopedResourceName(LOCAL_VAULT_LOCK_NAME), { mode: "exclusive", ifAvailable: true }, async (lock) => {
            if (!lock) {
                rejectAcquired?.(new LocalVaultError("IN_USE", "Vault is unlocked in another tab"));
                return;
            }
            settleAcquired?.(async () => {
                releaseHold?.();
                await request;
            });
            await hold;
        });
        void request.catch((error) => rejectAcquired?.(new LocalVaultError("IN_USE", "Unable to acquire the vault session lock", { cause: error })));
        return acquired;
    },
};

function canonicalJson(value: unknown) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new LocalVaultError("INVALID_PAYLOAD", "Vault payload is not JSON serializable");
    return serialized;
}
