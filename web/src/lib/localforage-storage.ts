import type { StateStorage } from "zustand/middleware";

import { createUserScopedLocalForage, getActiveLocalUserProfile } from "@/services/local-user-profiles";

export type LegacyStateStorage = Pick<StateStorage, "getItem" | "removeItem">;

export type LocalForageStorageOptions = {
    authoritative: StateStorage;
    legacy?: LegacyStateStorage | null;
};

export class LocalStorageMigrationError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "LocalStorageMigrationError";
    }
}

/**
 * Keep localForage authoritative while importing a legacy localStorage value once.
 * Operations for the same key are serialized so migration cannot overwrite a newer write.
 */
export function createLocalForageStorage({ authoritative, legacy = null }: LocalForageStorageOptions): StateStorage {
    const tails = new Map<string, Promise<void>>();

    const exclusive = <T>(name: string, operation: () => Promise<T>) => {
        const previous = tails.get(name) || Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.then(
            () => undefined,
            () => undefined,
        );
        tails.set(name, tail);
        void tail.finally(() => {
            if (tails.get(name) === tail) tails.delete(name);
        });
        return result;
    };

    const readAuthoritative = async (name: string) => (await Promise.resolve(authoritative.getItem(name))) ?? null;

    const migrateLegacy = async (name: string, value: string) => {
        let writeError: unknown;
        try {
            await Promise.resolve(authoritative.setItem(name, value));
        } catch (error) {
            writeError = error;
        }

        let verified: string | null;
        try {
            verified = await readAuthoritative(name);
        } catch (error) {
            throw new LocalStorageMigrationError(`Unable to verify migrated local state '${name}'`, { cause: error });
        }
        if (verified !== value) throw new LocalStorageMigrationError(`Unable to migrate legacy local state '${name}'`, { cause: writeError });

        try {
            await Promise.resolve(legacy?.removeItem(name));
        } catch {
            // The verified authoritative value wins; stale legacy data is ignored on future reads.
        }
        return verified;
    };

    return {
        getItem: (name) =>
            exclusive(name, async () => {
                const current = await readAuthoritative(name);
                if (current !== null || !legacy) return current;
                const oldValue = await Promise.resolve(legacy.getItem(name));
                if (oldValue === null) return null;
                return migrateLegacy(name, oldValue);
            }),
        setItem: (name, value) => exclusive(name, async () => void (await Promise.resolve(authoritative.setItem(name, value)))),
        removeItem: (name) =>
            exclusive(name, async () => {
                await Promise.resolve(authoritative.removeItem(name));
                if (legacy) await Promise.resolve(legacy.removeItem(name));
            }),
    };
}

const appStateStore = createUserScopedLocalForage({
    name: "infinite-canvas",
    storeName: "app_state",
});

const authoritativeStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        return (await appStateStore.getItem<string>(name)) ?? null;
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        await appStateStore.setItem(name, value);
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        await appStateStore.removeItem(name);
    },
};

const legacyStorage: LegacyStateStorage = {
    getItem: (name) => (typeof window === "undefined" || !getActiveLocalUserProfile()?.legacyOwner ? null : window.localStorage.getItem(name)),
    removeItem: (name) => {
        if (typeof window !== "undefined" && getActiveLocalUserProfile()?.legacyOwner) window.localStorage.removeItem(name);
    },
};

export const localForageStorage = createLocalForageStorage({ authoritative: authoritativeStorage, legacy: legacyStorage });
