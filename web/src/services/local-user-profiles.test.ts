import { describe, expect, test } from "bun:test";

import {
    activateLocalUserProfile,
    assertLocalPassword,
    completeLocalUserActivation,
    createLocalUserProfile,
    issueLocalUserActivation,
    listLocalUserProfiles,
    normalizeLocalUsername,
    provisionLocalUserProfile,
    registerLocalUserProfile,
    updateLocalUserProfile,
    userScopedDatabaseName,
    userScopedResourceName,
    verifyLocalUserActivation,
} from "./local-user-profiles";

describe("local user profiles", () => {
    test("normalizes usernames and derives a stable case-insensitive id", () => {
        expect(normalizeLocalUsername("  Alice  ")).toBe("Alice");
        expect(createLocalUserProfile("Alice").id).toBe(createLocalUserProfile("alice").id);
        expect(() => normalizeLocalUsername("   ")).toThrow("请输入用户名");
    });

    test("rejects a nine-character password and accepts ten characters", () => {
        expect(() => assertLocalPassword("123456789")).toThrow("至少需要 10 个字符");
        expect(() => assertLocalPassword("1234567890")).not.toThrow();
    });

    test("keeps the first user's existing database and isolates later users", () => {
        const first = createLocalUserProfile("first", true);
        const second = createLocalUserProfile("second", false);

        expect(first.role).toBe("admin");
        expect(second.role).toBe("user");

        activateLocalUserProfile(first);
        expect(userScopedDatabaseName("infinite-canvas")).toBe("infinite-canvas");
        const firstLock = userScopedResourceName("app-data");

        activateLocalUserProfile(second);
        expect(userScopedDatabaseName("infinite-canvas")).toBe(`infinite-canvas--${second.id}`);
        expect(userScopedResourceName("app-data")).not.toBe(firstLock);
    });

    test("requires the one-time activation code before a provisioned user can initialize", async () => {
        const storage = new MemoryProfileStorage();
        const owner = createLocalUserProfile("owner", true);
        await registerLocalUserProfile(owner, storage);
        const { profile: member, activationCode } = await provisionLocalUserProfile(owner.id, "member", "user", storage);

        expect(member.activation?.hash).not.toContain(activationCode.replaceAll("-", ""));
        await expect(verifyLocalUserActivation(member, "invalid-code")).rejects.toThrow("激活码无效");
        expect(await verifyLocalUserActivation(member, activationCode)).toBeUndefined();
        const activated = await completeLocalUserActivation(member.id, activationCode, storage);
        expect(activated.activation).toBeUndefined();
        expect(activated.activatedAt).toBeDefined();
        await expect(completeLocalUserActivation(member.id, activationCode, storage)).rejects.toThrow("需要管理员生成激活码");
    });

    test("lets an active administrator manage users and protects the last administrator", async () => {
        const storage = new MemoryProfileStorage();
        const owner = createLocalUserProfile("owner", true);
        await registerLocalUserProfile(owner, storage);
        const { profile: member } = await provisionLocalUserProfile(owner.id, "member", "user", storage);

        expect(listLocalUserProfiles(storage).map(({ username, role, status }) => ({ username, role, status }))).toEqual([
            { username: "owner", role: "admin", status: "active" },
            { username: "member", role: "user", status: "active" },
        ]);
        await expect(provisionLocalUserProfile(member.id, "blocked", "user", storage)).rejects.toThrow("只有已激活的管理员");
        await expect(updateLocalUserProfile(owner.id, owner.id, { role: "user" }, storage)).rejects.toThrow("不能移除");

        const provisionedAdmin = await provisionLocalUserProfile(owner.id, "backup-admin", "admin", storage);
        await expect(updateLocalUserProfile(provisionedAdmin.profile.id, owner.id, { status: "disabled" }, storage)).rejects.toThrow("只有已激活的管理员");
        const secondAdmin = await completeLocalUserActivation(provisionedAdmin.profile.id, provisionedAdmin.activationCode, storage);
        expect((await updateLocalUserProfile(secondAdmin.id, owner.id, { status: "disabled" }, storage)).status).toBe("disabled");
    });

    test("rotates unused activation codes and stores a versioned profile collection", async () => {
        const storage = new MemoryProfileStorage();
        const owner = createLocalUserProfile("owner", true);
        await registerLocalUserProfile(owner, storage);
        const first = await provisionLocalUserProfile(owner.id, "member", "user", storage);
        const second = await issueLocalUserActivation(owner.id, first.profile.id, storage);

        await expect(verifyLocalUserActivation(second.profile, first.activationCode)).rejects.toThrow("激活码无效");
        expect(await verifyLocalUserActivation(second.profile, second.activationCode)).toBeUndefined();
        expect(storage.readProfilesVersion()).toBe(3);
    });
});

class MemoryProfileStorage {
    private readonly values = new Map<string, string>();

    getItem(key: string) {
        return this.values.get(key) || null;
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }

    removeItem(key: string) {
        this.values.delete(key);
    }

    readProfilesVersion() {
        const stored = [...this.values.entries()].find(([key]) => key.includes("user-profiles"));
        return stored ? (JSON.parse(stored[1]) as { version: number }).version : 0;
    }
}
