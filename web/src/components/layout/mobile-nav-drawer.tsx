import { Drawer } from "antd";
import { CircleUserRound } from "lucide-react";
import { Link } from "react-router-dom";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/use-auth-store";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const profile = useAuthStore((state) => state.profile);

    return (
        <Drawer title="导航" placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            {profile ? (
                <div className="mb-4 flex min-w-0 items-center gap-3 border-b border-stone-200 px-3 pb-4 dark:border-stone-800">
                    <CircleUserRound className="size-5 shrink-0 text-stone-500 dark:text-stone-400" />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-stone-950 dark:text-stone-100">{profile.displayName}</div>
                        <div className="truncate text-xs text-stone-500 dark:text-stone-400">
                            {profile.username} · {profile.role === "admin" ? "管理员" : "用户"}
                        </div>
                    </div>
                </div>
            ) : null}
            <div className="space-y-1">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <Link
                            key={tool.slug}
                            to={`/${tool.slug}`}
                            onClick={onClose}
                            className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                            )}
                        >
                            <Icon className="size-5" />
                            <span>{tool.label}</span>
                        </Link>
                    );
                })}
            </div>
        </Drawer>
    );
}
