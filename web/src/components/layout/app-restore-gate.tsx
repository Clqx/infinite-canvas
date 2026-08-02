import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Spin } from "antd";
import { RefreshCw, RotateCcw, StepForward, Trash2 } from "lucide-react";

import { discardInvalidAppRestoreJournal, getPendingAppRestore, resumeAppRestore, rollbackAppRestore, subscribeAppRestore, type AppRestoreJournal } from "@/services/app-restore";

export function AppRestoreGate({ children }: { children: ReactNode }) {
    const { message, modal } = App.useApp();
    const [journal, setJournal] = useState<AppRestoreJournal | null | undefined>(undefined);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<"resume" | "rollback" | "">("");
    const loadSequence = useRef(0);

    const loadJournal = useCallback(async (remote = false) => {
        const sequence = ++loadSequence.current;
        setJournal(undefined);
        setError("");
        try {
            const pending = await getPendingAppRestore();
            if (sequence !== loadSequence.current) return;
            if (remote && !pending) {
                window.location.reload();
                return;
            }
            setJournal(pending);
        } catch (cause) {
            if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "恢复日志读取失败");
        }
    }, []);

    useEffect(() => {
        void loadJournal();
        return subscribeAppRestore((remote) => void loadJournal(remote));
    }, [loadJournal]);

    if (journal === undefined && !error) {
        return (
            <div className="flex h-dvh items-center justify-center bg-background">
                <Spin size="large" />
            </div>
        );
    }
    if (!journal && !error) return <>{children}</>;

    const resume = async () => {
        setBusy("resume");
        setError("");
        try {
            await resumeAppRestore();
            setJournal(null);
            message.success("备份副本导入已完成");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "继续恢复失败");
        } finally {
            setBusy("");
        }
    };

    const rollback = async () => {
        setBusy("rollback");
        setError("");
        try {
            await rollbackAppRestore();
            setJournal(null);
            message.success("未完成的恢复任务已回退");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "恢复回退失败");
        } finally {
            setBusy("");
        }
    };

    const discardInvalidJournal = () => {
        modal.confirm({
            title: "清理无法读取的恢复日志？",
            content: "此操作只清理恢复日志，不会删除现有数据。若此前写入曾被中断，可能需要稍后手动整理残留副本。",
            okText: "清理日志",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await discardInvalidAppRestoreJournal();
                setJournal(null);
                setError("");
                message.success("无法读取的恢复日志已清理");
            },
        });
    };

    return (
        <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-stone-950 dark:text-stone-100">
            <div className="w-full max-w-md">
                <h1 className="m-0 text-xl font-semibold">处理未完成的恢复任务</h1>
                <p className="mt-2 text-sm text-stone-500">{journal?.phase === "committing" ? "备份内容已完成暂存，可以继续导入或回退已写入的副本。" : "备份内容尚未完成暂存，需要回退后重新选择备份。"}</p>
                {journal ? (
                    <div className="mt-5 grid grid-cols-2 gap-3 border-y border-stone-200 py-4 text-sm dark:border-stone-800">
                        <RestoreMetric label="画布" value={journal.data.projects.length} />
                        <RestoreMetric label="资产" value={journal.data.assets.length} />
                        <RestoreMetric label="生成记录" value={journal.data.imageLogs.length + journal.data.videoLogs.length} />
                        <RestoreMetric label="媒体文件" value={journal.media.length} />
                    </div>
                ) : null}
                {error ? <div className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</div> : null}
                <div className="mt-5 flex flex-wrap gap-3">
                    {journal?.phase === "committing" ? (
                        <Button type="primary" icon={<StepForward className="size-4" />} loading={busy === "resume"} disabled={Boolean(busy)} onClick={() => void resume()}>
                            继续恢复
                        </Button>
                    ) : null}
                    <Button danger icon={<RotateCcw className="size-4" />} loading={busy === "rollback"} disabled={Boolean(busy) || !journal} onClick={() => void rollback()}>
                        回退恢复
                    </Button>
                    {error && !journal ? (
                        <>
                            <Button icon={<RefreshCw className="size-4" />} onClick={() => void loadJournal()}>
                                重试读取
                            </Button>
                            <Button danger icon={<Trash2 className="size-4" />} onClick={discardInvalidJournal}>
                                清理日志
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>
        </main>
    );
}

function RestoreMetric({ label, value }: { label: string; value: number }) {
    return (
        <div>
            <div className="text-xs text-stone-500">{label}</div>
            <div className="mt-1 font-medium">{value}</div>
        </div>
    );
}
