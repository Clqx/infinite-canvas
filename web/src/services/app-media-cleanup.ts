export async function cleanupAppMediaAfterFlush({
    flush,
    withUsedData,
    cleanupImages,
    cleanupMedia,
}: {
    flush: () => Promise<void>;
    withUsedData: (operation: (usedData: unknown) => Promise<void>) => Promise<void>;
    cleanupImages: (usedData: unknown) => Promise<void>;
    cleanupMedia: (usedData: unknown) => Promise<void>;
}) {
    await flush();
    await withUsedData(async (usedData) => {
        await Promise.all([cleanupImages(usedData), cleanupMedia(usedData)]);
    });
}
