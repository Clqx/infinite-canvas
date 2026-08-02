import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button, Input, Spin } from "antd";
import { KeyRound, ShieldCheck, UserRound, UsersRound } from "lucide-react";

import { MIN_LOCAL_PASSWORD_LENGTH, normalizeLocalUsername } from "@/services/local-user-profiles";
import { useAuthStore } from "@/stores/use-auth-store";

export function LocalVaultGate({ children }: { children: ReactNode }) {
    const status = useAuthStore((state) => state.status);
    const profiles = useAuthStore((state) => state.profiles);
    const profile = useAuthStore((state) => state.profile);
    const hasLegacyData = useAuthStore((state) => state.hasLegacyData);
    const error = useAuthStore((state) => state.saveError);
    const initialize = useAuthStore((state) => state.initialize);
    const setup = useAuthStore((state) => state.setup);
    const unlock = useAuthStore((state) => state.unlock);
    const selectProfile = useAuthStore((state) => state.selectProfile);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [activationCode, setActivationCode] = useState("");
    const [formError, setFormError] = useState("");

    useEffect(() => {
        void initialize();
    }, [initialize]);

    useEffect(() => {
        setUsername(profile?.username || "");
        setPassword("");
        setConfirmation("");
        setActivationCode("");
        setFormError("");
    }, [profile?.id, status]);

    if (status === "unlocked") return <>{children}</>;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setFormError("");
        if (status === "setup") {
            try {
                normalizeLocalUsername(username);
            } catch (validationError) {
                return setFormError(validationError instanceof Error ? validationError.message : "用户名不可用");
            }
        }
        if (password.length < MIN_LOCAL_PASSWORD_LENGTH) return setFormError(`密码至少需要 ${MIN_LOCAL_PASSWORD_LENGTH} 个字符`);
        if (status === "setup" && password !== confirmation) return setFormError("两次输入的密码不一致");
        try {
            await (status === "setup" ? setup(username, password, activationCode) : unlock(password));
        } catch {
            // Store state carries the actionable error without exposing encryption details.
        }
    };

    const passwordHelp = password.length > 0 && password.length < MIN_LOCAL_PASSWORD_LENGTH ? `还需要 ${MIN_LOCAL_PASSWORD_LENGTH - password.length} 个字符` : `至少 ${MIN_LOCAL_PASSWORD_LENGTH} 个字符`;
    const confirmationError = confirmation.length > 0 && password !== confirmation ? "两次输入的密码不一致" : "";
    const title = status === "account" ? "选择本地用户" : status === "setup" ? (profile ? `设置 ${profile.displayName} 的保险库` : "创建管理员") : status === "error" ? "本地保险库不可用" : `解锁 ${profile?.displayName || "本地用户"}`;

    return (
        <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-stone-950 dark:text-stone-100">
            {status === "booting" ? (
                <Spin size="large" />
            ) : (
                <form className="w-full max-w-sm" onSubmit={(event) => void submit(event)}>
                    <div className="mb-8 flex items-center gap-3">
                        <span className="size-9 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                        <div className="min-w-0">
                            <h1 className="m-0 truncate text-xl font-semibold">{title}</h1>
                            <p className="m-0 mt-1 text-sm text-stone-500">
                                {status === "account"
                                    ? "每个用户拥有独立的画布、素材、媒体、生成记录和连接配置。"
                                    : status === "setup"
                                      ? hasLegacyData
                                          ? "现有本地数据将在验证后归入该用户。"
                                          : "用户名用于区分本机数据，密码仅保存在你的记忆中。"
                                      : "输入该用户的本地密码以加载其数据。"}
                            </p>
                        </div>
                    </div>
                    {status === "account" ? (
                        <div className="space-y-3">
                            {profiles.map((item) => (
                                <Button
                                    key={item.id}
                                    className="h-12 w-full justify-between"
                                    disabled={item.status === "disabled"}
                                    icon={item.role === "admin" ? <ShieldCheck className="size-4" /> : <UserRound className="size-4" />}
                                    onClick={() => selectProfile(item.id)}
                                >
                                    <span className="min-w-0 flex-1 truncate text-left">{item.displayName}</span>
                                    <span className="shrink-0 text-xs text-stone-500">{item.status === "disabled" ? "已停用" : item.role === "admin" ? "管理员" : "用户"}</span>
                                </Button>
                            ))}
                            {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}
                        </div>
                    ) : status !== "error" ? (
                        <>
                            {status === "setup" ? (
                                <>
                                    {profile && !profile.legacyOwner ? (
                                        <>
                                            <label className="mb-2 block text-sm font-medium" htmlFor="local-activation-code">
                                                一次性激活码
                                            </label>
                                            <Input
                                                id="local-activation-code"
                                                autoFocus
                                                size="large"
                                                value={activationCode}
                                                autoComplete="one-time-code"
                                                onChange={(event) => setActivationCode(event.target.value)}
                                                prefix={<ShieldCheck className="size-4" />}
                                                placeholder="由本机管理员提供"
                                            />
                                        </>
                                    ) : null}
                                    <label className="mb-2 block text-sm font-medium" htmlFor="local-username">
                                        用户名
                                    </label>
                                    <Input
                                        id="local-username"
                                        autoFocus={!profile}
                                        size="large"
                                        value={username}
                                        disabled={Boolean(profile)}
                                        maxLength={32}
                                        autoComplete="username"
                                        onChange={(event) => setUsername(event.target.value)}
                                        prefix={<UserRound className="size-4" />}
                                        placeholder="输入本机用户名"
                                    />
                                </>
                            ) : null}
                            <label className={`mb-2 block text-sm font-medium ${status === "setup" ? "mt-4" : ""}`} htmlFor="local-password">
                                本地密码
                            </label>
                            <Input.Password
                                id="local-password"
                                autoFocus={status !== "setup"}
                                size="large"
                                value={password}
                                autoComplete={status === "setup" ? "new-password" : "current-password"}
                                onChange={(event) => setPassword(event.target.value)}
                                prefix={<KeyRound className="size-4" />}
                            />
                            <div className={`mt-1 text-xs ${password.length > 0 && password.length < MIN_LOCAL_PASSWORD_LENGTH ? "text-red-600 dark:text-red-400" : "text-stone-500"}`}>{passwordHelp}</div>
                            {status === "setup" ? (
                                <>
                                    <label className="mb-2 mt-4 block text-sm font-medium" htmlFor="local-password-confirmation">
                                        确认密码
                                    </label>
                                    <Input.Password
                                        id="local-password-confirmation"
                                        size="large"
                                        value={confirmation}
                                        autoComplete="new-password"
                                        status={confirmationError ? "error" : undefined}
                                        onChange={(event) => setConfirmation(event.target.value)}
                                    />
                                    {confirmationError ? <div className="mt-1 text-xs text-red-600 dark:text-red-400">{confirmationError}</div> : null}
                                </>
                            ) : null}
                            {formError || error ? <div className="mt-3 text-sm text-red-600 dark:text-red-400">{formError || error}</div> : null}
                            <Button className="mt-5 w-full" type="primary" htmlType="submit" size="large" loading={status === "unlocking"}>
                                {status === "setup" ? "创建并继续" : "解锁"}
                            </Button>
                        </>
                    ) : (
                        <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
                    )}
                    {status === "locked" ? (
                        <Button className="mt-4 w-full" type="text" icon={<UsersRound className="size-4" />} onClick={() => useAuthStore.setState({ status: "account", saveError: "" })}>
                            切换用户
                        </Button>
                    ) : null}
                </form>
            )}
        </main>
    );
}
