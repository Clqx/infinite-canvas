import { create } from "zustand";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
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
