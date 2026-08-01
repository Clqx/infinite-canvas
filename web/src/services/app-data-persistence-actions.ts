import { appDataPersistence } from "@/services/app-data-persistence";

let retryPromise: Promise<void> | null = null;

export function flushAppDataPersistence() {
    return appDataPersistence.flushAll();
}

export function retryAppDataPersistence() {
    if (retryPromise) return retryPromise;
    retryPromise = (async () => {
        const [{ useCanvasStore }, { useAssetStore }] = await Promise.all([import("@/stores/canvas/use-canvas-store"), import("@/stores/use-asset-store")]);
        const rehydrate: Promise<void>[] = [];
        if (!appDataPersistence.channels.canvas.getStatus().ready) rehydrate.push(Promise.resolve(useCanvasStore.persist.rehydrate()));
        if (!appDataPersistence.channels.assets.getStatus().ready) rehydrate.push(Promise.resolve(useAssetStore.persist.rehydrate()));
        if (rehydrate.length) await Promise.all(rehydrate);
        await appDataPersistence.retryAll();
    })().finally(() => {
        retryPromise = null;
    });
    return retryPromise;
}
