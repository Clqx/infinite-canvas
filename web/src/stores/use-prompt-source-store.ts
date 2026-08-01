import { create } from "zustand";

import { DEFAULT_PROMPT_SOURCES, createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";

export type PromptSourceSchedule = {
    intervalMinutes: number;
    lastFetchedAt: string;
};

export const PROMPT_SOURCE_STORE_KEY = "infinite-canvas:prompt_source_store_v2";

export const defaultPromptSourceSchedule: PromptSourceSchedule = {
    intervalMinutes: 30,
    lastFetchedAt: "",
};

export const PROMPT_SOURCE_INTERVAL_OPTIONS = [
    { label: "关闭定时", value: 0 },
    { label: "每 30 分钟", value: 30 },
    { label: "每 1 小时", value: 60 },
    { label: "每 6 小时", value: 360 },
    { label: "每 24 小时", value: 1440 },
];

type PromptSourceStore = {
    sources: PromptSource[];
    schedule: PromptSourceSchedule;
    addSource: () => PromptSource;
    saveSource: (source: PromptSource) => void;
    removeSource: (id: string) => void;
    toggleSource: (id: string, enabled: boolean) => void;
    updateSchedule: <K extends keyof PromptSourceSchedule>(key: K, value: PromptSourceSchedule[K]) => void;
};

export const usePromptSourceStore = create<PromptSourceStore>()((set) => ({
            sources: DEFAULT_PROMPT_SOURCES,
            schedule: defaultPromptSourceSchedule,
            addSource: () => createPromptSource(),
            saveSource: (source) =>
                set((state) => ({
                    sources: state.sources.some((item) => item.id === source.id)
                        ? state.sources.map((item) => (item.id === source.id && !item.builtIn ? createPromptSource(source) : item))
                        : [...state.sources, createPromptSource(source)],
                })),
            removeSource: (id) => set((state) => ({ sources: state.sources.filter((item) => item.id !== id || item.builtIn) })),
            toggleSource: (id, enabled) => set((state) => ({ sources: state.sources.map((item) => (item.id === id ? { ...item, enabled } : item)) })),
            updateSchedule: (key, value) => set((state) => ({ schedule: { ...state.schedule, [key]: value } })),
        }));

export function normalizePromptSourceState(value: unknown) {
    const persistedState = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<PromptSourceStore>) : {};
    const savedSources = Array.isArray(persistedState.sources) ? persistedState.sources : [];
    const enabledById = new Map(savedSources.map((source) => [source.id, source.enabled]));
    const builtIn = DEFAULT_PROMPT_SOURCES.map((source) => ({ ...source, enabled: enabledById.get(source.id) ?? source.enabled }));
    const custom = savedSources.filter((source) => !source.builtIn).map((source) => createPromptSource(source));
    return { sources: [...builtIn, ...custom], schedule: { ...defaultPromptSourceSchedule, ...(persistedState.schedule || {}) } };
}
