import { useEffect } from "react";
import { App } from "antd";

import { useAuthStore } from "@/stores/use-auth-store";

const MESSAGE_KEY = "vault-save-failure";

export function VaultSaveFailureNotifier() {
    const { message } = App.useApp();
    const status = useAuthStore((state) => state.status);
    const saveError = useAuthStore((state) => state.saveError);

    useEffect(() => {
        if (status === "unlocked" && saveError) {
            message.open({ key: MESSAGE_KEY, type: "error", duration: 0, content: `凭据保存失败：${saveError}` });
        } else {
            message.destroy(MESSAGE_KEY);
        }
        return () => message.destroy(MESSAGE_KEY);
    }, [message, saveError, status]);

    return null;
}
