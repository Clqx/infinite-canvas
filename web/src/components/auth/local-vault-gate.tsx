import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { App, Button, Input, Modal, Spin } from "antd";
import { KeyRound, RotateCcw } from "lucide-react";

import { useAuthStore } from "@/stores/use-auth-store";

export function LocalVaultGate({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const status = useAuthStore((state) => state.status);
    const hasLegacyData = useAuthStore((state) => state.hasLegacyData);
    const error = useAuthStore((state) => state.saveError);
    const initialize = useAuthStore((state) => state.initialize);
    const setup = useAuthStore((state) => state.setup);
    const unlock = useAuthStore((state) => state.unlock);
    const resetCredentials = useAuthStore((state) => state.resetCredentials);
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");

    useEffect(() => {
        void initialize();
    }, [initialize]);

    if (status === "unlocked") return <>{children}</>;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (status === "setup" && password !== confirmation) return message.error("两次输入的密码不一致");
        try {
            await (status === "setup" ? setup(password) : unlock(password));
            setPassword("");
            setConfirmation("");
        } catch {
            // Store state carries the actionable error without exposing cryptographic details.
        }
    };

    const confirmReset = () => {
        Modal.confirm({
            title: "重置本地凭据？",
            content: "此操作会删除 AI、WebDAV、Agent、模型偏好和提示词来源配置，不会删除画布、素材或媒体。",
            okText: "重置凭据",
            okType: "danger",
            cancelText: "取消",
            onOk: () => resetCredentials(),
        });
    };

    return (
        <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-stone-950 dark:text-stone-100">
            {status === "booting" ? (
                <Spin size="large" />
            ) : (
                <form className="w-full max-w-sm" onSubmit={(event) => void submit(event)}>
                    <div className="mb-8 flex items-center gap-3">
                        <span className="size-9 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                        <div>
                            <h1 className="m-0 text-xl font-semibold">{status === "setup" ? "创建本地保险库" : status === "error" ? "保险库不可用" : "解锁无限画布"}</h1>
                            <p className="m-0 mt-1 text-sm text-stone-500">{status === "setup" ? (hasLegacyData ? "已有配置将在加密验证后迁移。" : "设置一个仅保存在你记忆中的本地密码。") : "输入本地密码恢复凭据和连接配置。"}</p>
                        </div>
                    </div>
                    {status !== "error" ? (
                        <>
                            <label className="mb-2 block text-sm font-medium">本地密码</label>
                            <Input.Password autoFocus size="large" value={password} autoComplete={status === "setup" ? "new-password" : "current-password"} onChange={(event) => setPassword(event.target.value)} prefix={<KeyRound className="size-4" />} />
                            {status === "setup" ? (
                                <>
                                    <label className="mb-2 mt-4 block text-sm font-medium">确认密码</label>
                                    <Input.Password size="large" value={confirmation} autoComplete="new-password" onChange={(event) => setConfirmation(event.target.value)} />
                                </>
                            ) : null}
                            {error ? <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div> : null}
                            <Button className="mt-5 w-full" type="primary" htmlType="submit" size="large" loading={status === "unlocking"} disabled={password.length < 10 || (status === "setup" && confirmation.length < 10)}>
                                {status === "setup" ? "创建并继续" : "解锁"}
                            </Button>
                        </>
                    ) : (
                        <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
                    )}
                    {status === "locked" || status === "error" ? (
                        <Button className="mt-4 w-full" type="text" danger icon={<RotateCcw className="size-4" />} onClick={confirmReset}>
                            忘记密码，重置凭据
                        </Button>
                    ) : null}
                </form>
            )}
        </main>
    );
}
