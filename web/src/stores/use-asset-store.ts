import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { ASSET_STATE_STORAGE_KEY, appDataPersistence, assetStateStorage, withAuthoritativeAppData } from "@/services/app-data-persistence";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { cleanupAppMediaAfterFlush } from "@/services/app-media-cleanup";
import { withAllStoredGenerationLogs } from "@/services/generation-log-storage";
import { addTombstones, migrateAssetData, type SyncTombstone } from "@/services/app-data-schema";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    assetTombstones: SyncTombstone[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[], tombstones?: SyncTombstone[]) => void;
    cleanupImages: (extra?: unknown) => Promise<void>;
};

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await assetStateStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset) => {
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey)
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        return parsed;
    },
    setItem: (name, value) => assetStateStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => assetStateStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            assetTombstones: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => ({
                    assets: state.assets.filter((asset) => asset.id !== id),
                    assetTombstones: addTombstones(state.assetTombstones, [id], new Date().toISOString(), nanoid),
                })),
            replaceAssets: (assets, tombstones) => set((state) => ({ assets, assetTombstones: tombstones || state.assetTombstones })),
            cleanupImages: async (extra) => {
                const { readPendingAppRestoreMediaKeys } = await import("@/services/app-restore");
                const pendingRestoreMedia = (await readPendingAppRestoreMediaKeys()).map((storageKey) => ({ storageKey }));
                await cleanupAppMediaAfterFlush({
                    flush: appDataPersistence.flushAll,
                    withUsedData: (operation) => withAuthoritativeAppData((data) => withAllStoredGenerationLogs((generationLogs) => operation({ ...data, generationLogs, pendingRestoreMedia, extra }))),
                    cleanupImages: cleanupUnusedImages,
                    cleanupMedia: cleanupUnusedMedia,
                });
            },
        }),
        {
            name: ASSET_STATE_STORAGE_KEY,
            storage: assetStorage,
            skipHydration: true,
            version: 2,
            migrate: (state, version) => migrateAssetData(state, version) as AssetStore,
            partialize: (state) => ({ assets: state.assets, assetTombstones: state.assetTombstones }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    if (assetStateStorage.markHydrationError(error)) useAssetStore.setState({ hydrated: false });
                    return;
                }
                if (assetStateStorage.markHydrated()) useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);
