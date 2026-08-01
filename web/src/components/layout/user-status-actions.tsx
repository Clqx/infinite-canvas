import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
import { BookOpen, CircleAlert, HardDrive, Keyboard, LoaderCircle, LockKeyhole, Puzzle, Settings2 } from "lucide-react";
import { App } from "antd";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { DOCS_URL } from "@/constant/env";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { appDataPersistence } from "@/services/app-data-persistence";
import { retryAppDataPersistence } from "@/services/app-data-persistence-actions";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAuthStore } from "@/stores/use-auth-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { message, modal } = App.useApp();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const lock = useAuthStore((state) => state.lock);
    const persistenceStatus = useSyncExternalStore(appDataPersistence.subscribe, appDataPersistence.getStatus, appDataPersistence.getStatus);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const gitHubClassName = "size-7 text-base";
    const gitHubStyle = iconStyle;

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            <button
                type="button"
                className={cn(naturalIconClass, persistenceStatus.hasError && "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300")}
                style={persistenceStatus.hasError ? undefined : iconStyle}
                disabled={!persistenceStatus.hasError}
                onClick={() => {
                    if (persistenceStatus.hasConflict) {
                        modal.confirm({
                            title: "重新加载其他标签页保存的数据？",
                            content: "当前标签页尚未保存的更改将被丢弃。建议先导出需要保留的内容。",
                            okText: "重新加载",
                            okButtonProps: { danger: true },
                            cancelText: "取消",
                            onOk: () => window.location.reload(),
                        });
                        return;
                    }
                    void retryAppDataPersistence().catch((error) => message.error(error instanceof Error ? error.message : "重试保存失败"));
                }}
                aria-label={persistenceStatus.hasConflict ? "本地数据存在冲突，点击重新加载" : persistenceStatus.hasError ? "本地数据保存失败，点击重试" : persistenceStatus.dirty ? "正在保存本地数据" : "本地数据已保存"}
                title={persistenceStatus.hasError ? persistenceStatus.error : persistenceStatus.dirty ? "正在保存" : "已保存"}
            >
                {persistenceStatus.hasError ? <CircleAlert className="size-4" /> : persistenceStatus.dirty ? <LoaderCircle className="size-4 animate-spin" /> : <HardDrive className="size-4" />}
            </button>
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label="节点插件" title="节点插件">
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label="文档" title="文档">
                <BookOpen className="size-4" />
            </a>
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label="配置" title="配置">
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => void lock().catch((error) => message.error(error instanceof Error ? error.message : "锁定失败"))} aria-label="锁定凭据保险库" title="锁定">
                <LockKeyhole className="size-4" />
            </button>
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
            <VersionReleaseModal style={versionStyle} />
            <GitHubLink className={cn("bg-transparent hover:bg-transparent dark:hover:bg-transparent", gitHubClassName)} style={gitHubStyle} />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}
