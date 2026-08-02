import { App, Button } from "antd";
import { Download, FileCheck2, FolderInput } from "lucide-react";
import { useRef, useState } from "react";

import { downloadAppBackup, MAX_APP_BACKUP_MEDIA_BYTES, verifyAppBackup, type AppBackupSummary } from "@/services/app-backup";
import { importAppBackupAsCopies } from "@/services/app-restore";

export function AppBackupPanel() {
    const { message, modal } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const importInputRef = useRef<HTMLInputElement>(null);
    const [exporting, setExporting] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [importing, setImporting] = useState(false);
    const [summary, setSummary] = useState<AppBackupSummary | null>(null);

    const exportBackup = async () => {
        setExporting(true);
        try {
            const result = await downloadAppBackup();
            setSummary(result);
            message.success("完整备份已生成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "完整备份生成失败");
        } finally {
            setExporting(false);
        }
    };

    const importBackup = (file?: File) => {
        if (!file) return;
        importInputRef.current && (importInputRef.current.value = "");
        modal.confirm({
            title: "将备份导入为副本？",
            content: "导入会创建新的画布、资产、生成记录和媒体键，不会覆盖当前内容。",
            okText: "导入为副本",
            cancelText: "取消",
            onOk: async () => {
                setImporting(true);
                try {
                    const result = await importAppBackupAsCopies(file);
                    message.success(`已导入 ${result.projects} 个画布、${result.assets} 个资产和 ${result.imageLogs + result.videoLogs} 条生成记录`);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "备份副本导入失败");
                    throw error;
                } finally {
                    setImporting(false);
                }
            },
        });
    };

    const verifyBackup = async (file?: File) => {
        if (!file) return;
        setVerifying(true);
        try {
            const result = await verifyAppBackup(file);
            setSummary(result);
            message.success("恢复演练通过，备份包完整可读");
        } catch (error) {
            setSummary(null);
            message.error(error instanceof Error ? error.message : "恢复演练失败");
        } finally {
            setVerifying(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <section className="border-y border-stone-200 py-5 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div className="text-sm font-semibold">数据备份</div>
                    <div className="mt-1 text-xs text-stone-500">完整备份媒体上限 {MAX_APP_BACKUP_MEDIA_BYTES / 1024 / 1024}MB</div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button icon={<Download className="size-4" />} loading={exporting} disabled={verifying || importing} onClick={() => void exportBackup()}>
                        导出完整备份
                    </Button>
                    <Button icon={<FileCheck2 className="size-4" />} loading={verifying} disabled={exporting || importing} onClick={() => inputRef.current?.click()}>
                        恢复演练
                    </Button>
                    <Button icon={<FolderInput className="size-4" />} loading={importing} disabled={exporting || verifying} onClick={() => importInputRef.current?.click()}>
                        导入为副本
                    </Button>
                    <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void verifyBackup(event.target.files?.[0])} />
                    <input ref={importInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => importBackup(event.target.files?.[0])} />
                </div>
            </div>
            {summary ? (
                <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-stone-200 pt-4 text-sm dark:border-stone-800 md:grid-cols-3">
                    <BackupMetric label="画布" value={summary.projects} />
                    <BackupMetric label="资产" value={summary.assets} />
                    <BackupMetric label="生成记录" value={summary.imageLogs + summary.videoLogs} />
                    <BackupMetric label="媒体文件" value={summary.files} />
                    <BackupMetric label="媒体体积" value={formatBytes(summary.bytes)} />
                    <BackupMetric label="备份时间" value={new Date(summary.exportedAt).toLocaleString()} />
                </dl>
            ) : null}
        </section>
    );
}

function BackupMetric({ label, value }: { label: string; value: string | number }) {
    return (
        <div>
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="mt-1 break-words font-medium">{value}</dd>
        </div>
    );
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
