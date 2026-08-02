import { useRef, useState } from "react";
import { App, Button, Input, Modal } from "antd";
import { Download, KeyRound, RotateCcw, Upload } from "lucide-react";
import { saveAs } from "file-saver";

import { useAuthStore } from "@/stores/use-auth-store";
import { readCredentialExportFile } from "@/services/credential-vault";

export function VaultSecurityPanel() {
    const { message } = App.useApp();
    const changePassword = useAuthStore((state) => state.changePassword);
    const exportCredentials = useAuthStore((state) => state.exportCredentials);
    const importCredentials = useAuthStore((state) => state.importCredentials);
    const resetCredentials = useAuthStore((state) => state.resetCredentials);
    const saving = useAuthStore((state) => state.saving);
    const saveError = useAuthStore((state) => state.saveError);
    const inputRef = useRef<HTMLInputElement>(null);
    const [newPassword, setNewPassword] = useState("");
    const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
    const [backupPassword, setBackupPassword] = useState("");
    const [backupPasswordConfirmation, setBackupPasswordConfirmation] = useState("");
    const [busy, setBusy] = useState(false);

    const updatePassword = async () => {
        if (newPassword !== newPasswordConfirmation) return message.error("两次输入的新密码不一致");
        setBusy(true);
        try {
            await changePassword(newPassword);
            setNewPassword("");
            setNewPasswordConfirmation("");
            message.success("本地密码已修改");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改密码失败");
        } finally {
            setBusy(false);
        }
    };

    const exportBackup = async () => {
        if (backupPassword !== backupPasswordConfirmation) return message.error("两次输入的备份密码不一致");
        setBusy(true);
        try {
            const encrypted = await exportCredentials(backupPassword);
            saveAs(new Blob([encrypted], { type: "application/json;charset=utf-8" }), "infinite-canvas-credentials.encrypted.json");
            message.success("加密凭据备份已导出");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出失败");
        } finally {
            setBusy(false);
        }
    };

    const importBackup = async (file: File) => {
        setBusy(true);
        try {
            await importCredentials(backupPassword, await readCredentialExportFile(file));
            message.success("加密凭据备份已恢复");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "恢复失败");
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    const confirmReset = () => {
        Modal.confirm({
            title: "重置本地凭据？",
            content: "AI、WebDAV、Agent、模型偏好和提示词来源配置会被删除，画布、素材及媒体不会被删除。",
            okText: "重置凭据",
            okType: "danger",
            cancelText: "取消",
            onOk: () => resetCredentials(),
        });
    };

    return (
        <div className="space-y-6">
            <section className="border-b border-stone-200 pb-6 dark:border-stone-800">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
                    <KeyRound className="size-4" /> 修改本地密码
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                    <Input.Password value={newPassword} autoComplete="new-password" placeholder="至少 10 个字符" onChange={(event) => setNewPassword(event.target.value)} />
                    <Input.Password value={newPasswordConfirmation} autoComplete="new-password" placeholder="再次输入新密码" onChange={(event) => setNewPasswordConfirmation(event.target.value)} />
                </div>
                <Button className="mt-3" type="primary" loading={busy} disabled={newPassword.length < 10 || newPasswordConfirmation.length < 10} onClick={() => void updatePassword()}>
                    修改密码
                </Button>
            </section>

            <section className="border-b border-stone-200 pb-6 dark:border-stone-800">
                <div className="mb-1 text-sm font-semibold">加密凭据备份</div>
                <div className="mb-4 text-xs text-stone-500">备份包含渠道、WebDAV、提示词来源和 Agent 连接配置，使用独立密码加密。</div>
                <div className="grid gap-4 md:grid-cols-2">
                    <Input.Password value={backupPassword} autoComplete="new-password" placeholder="备份密码，至少 10 个字符" onChange={(event) => setBackupPassword(event.target.value)} />
                    <Input.Password value={backupPasswordConfirmation} autoComplete="new-password" placeholder="再次输入备份密码" onChange={(event) => setBackupPasswordConfirmation(event.target.value)} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button icon={<Download className="size-4" />} loading={busy} disabled={backupPassword.length < 10 || backupPasswordConfirmation.length < 10} onClick={() => void exportBackup()}>
                        导出加密备份
                    </Button>
                    <Button icon={<Upload className="size-4" />} loading={busy} disabled={backupPassword.length < 10} onClick={() => inputRef.current?.click()}>
                        恢复加密备份
                    </Button>
                    <input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void importBackup(event.target.files[0])} />
                </div>
            </section>

            <section>
                <div className="mb-1 text-sm font-semibold">凭据重置</div>
                <div className="mb-3 text-xs text-stone-500">仅在当前用户已解锁时清空连接配置；本地密码、画布、素材及媒体保持不变。</div>
                <Button danger icon={<RotateCcw className="size-4" />} onClick={confirmReset}>
                    重置全部凭据
                </Button>
            </section>
            <div className={`text-xs ${saveError ? "text-red-600 dark:text-red-400" : "text-stone-500"}`}>{saveError || (saving ? "正在加密保存…" : "凭据已加密保存")}</div>
        </div>
    );
}
