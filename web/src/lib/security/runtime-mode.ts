export const unsafeExtensionsEnabled = import.meta.env.DEV && import.meta.env.VITE_UNSAFE_EXTENSIONS === "1";

export function assertUnsafeExtensionsEnabled() {
    if (!unsafeExtensionsEnabled) throw new Error("安全模式已禁用动态插件和自定义调用脚本。仅可在本地开发环境显式启用不安全扩展模式。");
}
