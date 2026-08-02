import { createUserScopedLocalForage } from "@/services/local-user-profiles";

type Candidate = { firstSeenAt: number };

export type MediaGarbageCollectorStorage = {
    getItem: (key: string) => Promise<unknown> | unknown;
    setItem: (key: string, value: Candidate) => Promise<unknown> | unknown;
    removeItem: (key: string) => Promise<unknown> | unknown;
};

export type MediaGarbageCollector = {
    protect: (key: string) => Promise<void>;
    findDeletions: (allKeys: Iterable<string>, usedKeys: ReadonlySet<string>) => Promise<string[]>;
    confirmDeleted: (keys: Iterable<string>) => Promise<void>;
};

export function createMediaGarbageCollector({ storage, graceMs = 5 * 60_000, now = Date.now }: { storage: MediaGarbageCollectorStorage; graceMs?: number; now?: () => number }): MediaGarbageCollector {
    const protect = async (key: string) => void (await Promise.resolve(storage.removeItem(key)));

    return {
        protect,
        findDeletions: async (allKeys, usedKeys) => {
            const deletions: string[] = [];
            const checkedAt = now();
            for (const key of new Set(allKeys)) {
                if (usedKeys.has(key)) {
                    await protect(key);
                    continue;
                }
                const stored = await Promise.resolve(storage.getItem(key));
                const firstSeenAt = stored && typeof stored === "object" && "firstSeenAt" in stored && typeof stored.firstSeenAt === "number" ? stored.firstSeenAt : null;
                if (firstSeenAt === null || firstSeenAt > checkedAt) {
                    await Promise.resolve(storage.setItem(key, { firstSeenAt: checkedAt }));
                    continue;
                }
                if (checkedAt - firstSeenAt >= graceMs) deletions.push(key);
            }
            return deletions;
        },
        confirmDeleted: async (keys) => {
            for (const key of new Set(keys)) await protect(key);
        },
    };
}

const candidateStore = createUserScopedLocalForage({ name: "infinite-canvas", storeName: "media_gc_candidates" });

export const mediaGarbageCollector = createMediaGarbageCollector({ storage: candidateStore });
