import type { ReactNode } from "react";
import { useEffect } from "react";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ClientRootInit } from "@/components/layout/client-root-init";
import { LocalVaultGate } from "@/components/auth/local-vault-gate";
import { VaultSaveFailureNotifier } from "@/components/auth/vault-save-failure-notifier";
import { getAntThemeConfig } from "@/lib/app-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

export function AppProviders({ children }: { children: ReactNode }) {
    const theme = useThemeStore((state) => state.theme);
    const dark = theme === "dark";

    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = theme;
    }, [dark, theme]);

    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark)}>
            <ProConfigProvider dark={dark}>
                <App>
                    <VaultSaveFailureNotifier />
                    <QueryClientProvider client={queryClient}>
                        <LocalVaultGate>
                            <ClientRootInit>{children}</ClientRootInit>
                        </LocalVaultGate>
                    </QueryClientProvider>
                </App>
            </ProConfigProvider>
        </ConfigProvider>
    );
}
