import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { App, Button, Spin } from "antd";

import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { consumeLegacySecretNotice } from "@/lib/security/bootstrap-secrets";
import { appDataPersistence } from "@/services/app-data-persistence";
import { retryAppDataPersistence } from "@/services/app-data-persistence-actions";
import { installAppDataPersistenceLifecycle } from "@/services/app-data-lifecycle";

const PERSISTENCE_NOTIFICATION_KEY = "app-data-persistence-error";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message, modal, notification } = App.useApp();
    const persistenceStatus = useSyncExternalStore(appDataPersistence.subscribe, appDataPersistence.getStatus, appDataPersistence.getStatus);
    usePromptSourceScheduler();

    useEffect(() => {
        if (consumeLegacySecretNotice()) message.warning("已忽略并清除 URL 中的不安全凭据，请在加密保险库中重新填写");
    }, [message]);

    useEffect(() => installAppDataPersistenceLifecycle({ documentTarget: document, windowTarget: window, persistence: appDataPersistence }), []);

    useEffect(() => {
        if (!persistenceStatus.hasError) {
            notification.destroy(PERSISTENCE_NOTIFICATION_KEY);
            return;
        }
        notification.error({
            key: PERSISTENCE_NOTIFICATION_KEY,
            message: persistenceStatus.hasConflict ? "检测到本地数据冲突" : "本地数据保存失败",
            description: persistenceStatus.error,
            duration: 0,
            btn: persistenceStatus.hasConflict ? (
                <Button
                    danger
                    size="small"
                    onClick={() =>
                        modal.confirm({
                            title: "重新加载其他标签页保存的数据？",
                            content: "当前标签页尚未保存的更改将被丢弃。建议先导出需要保留的内容。",
                            okText: "重新加载",
                            okButtonProps: { danger: true },
                            cancelText: "取消",
                            onOk: () => window.location.reload(),
                        })
                    }
                >
                    重新加载
                </Button>
            ) : (
                <Button size="small" type="primary" onClick={() => void retryAppDataPersistence().catch(() => undefined)}>
                    重试
                </Button>
            ),
        });
    }, [modal, notification, persistenceStatus.error, persistenceStatus.hasConflict, persistenceStatus.hasError]);

    if (!persistenceStatus.ready) {
        return (
            <div className="flex h-dvh w-full items-center justify-center bg-background px-6 text-center text-foreground">
                {persistenceStatus.hasError ? (
                    <div className="max-w-lg">
                        <div className="text-base font-semibold">本地数据读取失败</div>
                        <div className="mt-2 text-sm text-stone-500 dark:text-stone-400">{persistenceStatus.error}</div>
                        <Button className="mt-5" type="primary" onClick={() => void retryAppDataPersistence().catch((error) => message.error(error instanceof Error ? error.message : "重试读取失败"))}>
                            重试读取
                        </Button>
                    </div>
                ) : (
                    <Spin size="large" />
                )}
            </div>
        );
    }

    return <>{children}</>;
}
