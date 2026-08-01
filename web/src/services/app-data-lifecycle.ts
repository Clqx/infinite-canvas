type LifecycleEventTarget = {
    addEventListener: (type: string, listener: EventListener) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
};

type PersistenceLifecycle = {
    flushAll: () => Promise<void>;
    runCheckpoints: () => void;
    hasDirtyData: () => boolean;
    hasErrors: () => boolean;
};

export function installAppDataPersistenceLifecycle({
    documentTarget,
    windowTarget,
    persistence,
}: {
    documentTarget: LifecycleEventTarget & { visibilityState: DocumentVisibilityState };
    windowTarget: LifecycleEventTarget;
    persistence: PersistenceLifecycle;
}) {
    const flush = () => void persistence.flushAll().catch(() => undefined);
    const flushWhenHidden: EventListener = () => {
        if (documentTarget.visibilityState === "hidden") flush();
    };
    const warnBeforeUnload: EventListener = (event) => {
        persistence.runCheckpoints();
        if (!persistence.hasDirtyData() && !persistence.hasErrors()) return;
        event.preventDefault();
        (event as BeforeUnloadEvent).returnValue = "";
    };

    documentTarget.addEventListener("visibilitychange", flushWhenHidden);
    windowTarget.addEventListener("pagehide", flush);
    windowTarget.addEventListener("beforeunload", warnBeforeUnload);

    return () => {
        documentTarget.removeEventListener("visibilitychange", flushWhenHidden);
        windowTarget.removeEventListener("pagehide", flush);
        windowTarget.removeEventListener("beforeunload", warnBeforeUnload);
    };
}
