import type { ReactNode } from "react";
import { useEffect } from "react";
import { App } from "antd";

import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { consumeLegacySecretNotice } from "@/lib/security/bootstrap-secrets";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    usePromptSourceScheduler();

    useEffect(() => {
        if (consumeLegacySecretNotice()) message.warning("已忽略并清除 URL 中的不安全凭据，请在加密保险库中重新填写");
    }, [message]);

    return <>{children}</>;
}
