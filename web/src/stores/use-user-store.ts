import { create } from "zustand";

import type { LocalUserRole } from "@/services/local-user-profiles";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    role: LocalUserRole;
    avatarUrl: string;
};

type UserStore = {
    user: LocalUser | null;
    setSession: (user: LocalUser) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: null,
    setSession: (user) => set({ user }),
    clearSession: () => set({ user: null }),
}));
