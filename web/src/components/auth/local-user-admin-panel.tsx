import { useState } from "react";
import { App, Button, Input, Select, Switch, Tooltip } from "antd";
import copy from "copy-to-clipboard";
import { Copy, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";

import { issueLocalUserActivation, listLocalUserProfiles, provisionLocalUserProfile, updateLocalUserProfile, type LocalUserRole, type ProvisionedLocalUser } from "@/services/local-user-profiles";
import { useAuthStore } from "@/stores/use-auth-store";

const roleOptions = [
    { value: "user", label: "用户" },
    { value: "admin", label: "管理员" },
];

export function LocalUserAdminPanel() {
    const { message, modal } = App.useApp();
    const authStatus = useAuthStore((state) => state.status);
    const currentUser = useAuthStore((state) => state.profile);
    const profiles = useAuthStore((state) => state.profiles);
    const [username, setUsername] = useState("");
    const [role, setRole] = useState<LocalUserRole>("user");
    const [saving, setSaving] = useState(false);

    if (authStatus !== "unlocked" || !currentUser || currentUser.role !== "admin" || currentUser.status !== "active") return null;

    const refresh = () => {
        const next = listLocalUserProfiles();
        useAuthStore.setState({ profiles: next });
    };

    const createUser = async () => {
        setSaving(true);
        try {
            const provisioned = await provisionLocalUserProfile(currentUser.id, username, role);
            setUsername("");
            setRole("user");
            refresh();
            showActivation(provisioned);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建用户失败");
        } finally {
            setSaving(false);
        }
    };

    const updateUser = async (profileId: string, patch: Parameters<typeof updateLocalUserProfile>[2]) => {
        try {
            await updateLocalUserProfile(currentUser.id, profileId, patch);
            refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新用户失败");
        }
    };

    const regenerateActivation = async (profileId: string) => {
        setSaving(true);
        try {
            const provisioned = await issueLocalUserActivation(currentUser.id, profileId);
            refresh();
            showActivation(provisioned);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成激活码失败");
        } finally {
            setSaving(false);
        }
    };

    const showActivation = ({ profile, activationCode }: ProvisionedLocalUser) => {
        modal.info({
            title: `${profile.displayName} 的一次性激活码`,
            content: (
                <div className="space-y-3">
                    <p className="m-0 text-sm text-stone-600 dark:text-stone-300">关闭后不再显示。重新生成会使之前未使用的激活码失效。</p>
                    <Input
                        readOnly
                        value={activationCode}
                        className="font-mono"
                        suffix={
                            <Tooltip title="复制激活码">
                                <Button
                                    type="text"
                                    size="small"
                                    icon={<Copy className="size-4" />}
                                    aria-label="复制激活码"
                                    onClick={() => {
                                        copy(activationCode);
                                        void message.success("激活码已复制");
                                    }}
                                />
                            </Tooltip>
                        }
                    />
                </div>
            ),
            okText: "关闭",
        });
    };

    return (
        <div className="space-y-6">
            <section>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <UserPlus className="size-4" />
                    创建用户
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
                    <Input value={username} maxLength={32} placeholder="用户名" onChange={(event) => setUsername(event.target.value)} onPressEnter={() => void createUser()} />
                    <Select value={role} options={roleOptions} onChange={setRole} />
                    <Button type="primary" loading={saving} disabled={!username.trim()} icon={<UserPlus className="size-4" />} onClick={() => void createUser()}>
                        创建
                    </Button>
                </div>
            </section>

            <section>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <ShieldCheck className="size-4" />
                    本机用户
                </div>
                <div className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {profiles.map((profile) => {
                        const isCurrent = profile.id === currentUser.id;
                        return (
                            <div key={profile.id} className="grid min-h-14 items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_140px_128px_32px]">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">
                                        {profile.displayName}
                                        {isCurrent ? <span className="ml-2 text-xs font-normal text-stone-500">当前用户</span> : null}
                                    </div>
                                    <div className="mt-0.5 truncate text-xs text-stone-500">{profile.username}</div>
                                </div>
                                <Select value={profile.role} options={roleOptions} disabled={isCurrent || saving} onChange={(nextRole: LocalUserRole) => void updateUser(profile.id, { role: nextRole })} />
                                <div className="flex items-center justify-end gap-2 text-xs text-stone-500">
                                    <span>{profile.status === "disabled" ? "已停用" : profile.activation ? "待激活" : "已启用"}</span>
                                    <Switch size="small" checked={profile.status === "active"} disabled={isCurrent || saving} onChange={(active) => void updateUser(profile.id, { status: active ? "active" : "disabled" })} />
                                </div>
                                {!isCurrent && !profile.legacyOwner && profile.status === "active" && !profile.activatedAt ? (
                                    <Tooltip title="生成新的激活码">
                                        <Button
                                            type="text"
                                            disabled={saving}
                                            icon={<RefreshCw className="size-4" />}
                                            aria-label={`为 ${profile.displayName} 生成新的激活码`}
                                            onClick={() => void regenerateActivation(profile.id)}
                                        />
                                    </Tooltip>
                                ) : (
                                    <span />
                                )}
                            </div>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}
