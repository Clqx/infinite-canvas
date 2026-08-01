import { describe, expect, test } from "bun:test";

import { createLocalVault, LOCAL_VAULT_ACTIVE_KEY, LOCAL_VAULT_PENDING_KEY, LocalVaultError, type LocalVaultStorage } from "./local-vault";

type TestPayload = { schemaVersion: 1; secret: string };

const oldPassword = "old password for local vault";
const newPassword = "new password for local vault";

describe("local vault", () => {
    test("sets up, locks, unlocks, and returns defensive payload copies", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        const created = await vault.setup(oldPassword, payload("first"));
        created.secret = "mutated outside";

        expect(vault.read()).toEqual(payload("first"));
        expect((await vault.inspect()).hasActive).toBe(true);
        expect(storage.values.get(LOCAL_VAULT_PENDING_KEY)).toBeUndefined();

        await vault.lock();
        expect(vault.isUnlocked()).toBe(false);
        expect(() => vault.read()).toThrow(LocalVaultError);
        expect(await vault.unlock(oldPassword)).toEqual(payload("first"));
    });

    test("keeps the previous active envelope when pending verification fails", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("stable"));
        const previousActive = storage.values.get(LOCAL_VAULT_ACTIVE_KEY);
        storage.corruptNextReadFor = LOCAL_VAULT_PENDING_KEY;

        await expect(vault.update(payload("not committed"))).rejects.toBeDefined();
        expect(storage.values.get(LOCAL_VAULT_ACTIVE_KEY)).toBe(previousActive);

        const afterCrash = testVault(storage);
        expect(await afterCrash.unlock(oldPassword)).toEqual(payload("stable"));
    });

    test("keeps the previous active envelope when the active commit throws", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("stable"));
        const previousActive = storage.values.get(LOCAL_VAULT_ACTIVE_KEY);
        storage.failNextSetFor = LOCAL_VAULT_ACTIVE_KEY;

        await expect(vault.update(payload("not committed"))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
        expect(storage.values.get(LOCAL_VAULT_ACTIVE_KEY)).toBe(previousActive);
        expect(storage.values.has(LOCAL_VAULT_PENDING_KEY)).toBe(true);

        const afterCrash = testVault(storage);
        expect(await afterCrash.unlock(oldPassword)).toEqual(payload("stable"));
    });

    test("accepts an active write that committed before storage reported failure", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("before"));
        storage.writeThenFailNextSetFor = LOCAL_VAULT_ACTIVE_KEY;

        expect(await vault.update(payload("committed"))).toEqual(payload("committed"));
        await vault.lock();
        const reopened = testVault(storage);
        expect(await reopened.unlock(oldPassword)).toEqual(payload("committed"));
    });

    test("serializes writes and leaves the last successfully committed payload active", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("initial"));
        storage.delayMs = 2;

        const first = vault.update(payload("first update"));
        const second = vault.update(payload("second update"));
        await Promise.all([first, second]);
        await vault.flush();
        await vault.lock();

        const reopened = testVault(storage);
        expect(await reopened.unlock(oldPassword)).toEqual(payload("second update"));
    });

    test("changes the password only after the new active value verifies", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("before change"));
        await vault.changePassword(newPassword, payload("after change"));
        await vault.lock();

        const reopened = testVault(storage);
        await expect(reopened.unlock(oldPassword)).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
        expect(await reopened.unlock(newPassword)).toEqual(payload("after change"));
    });

    test("failed unlocks never rewrite active encrypted data", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("stable"));
        await vault.lock();
        const original = storage.values.get(LOCAL_VAULT_ACTIVE_KEY)!;

        await expect(vault.unlock("incorrect password")).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
        expect(storage.values.get(LOCAL_VAULT_ACTIVE_KEY)).toBe(original);

        const parsed = JSON.parse(original) as { ciphertext: string; version: number };
        const tampered = JSON.stringify({ ...parsed, ciphertext: `${parsed.ciphertext.slice(0, -4)}AAAA` });
        storage.values.set(LOCAL_VAULT_ACTIVE_KEY, tampered);
        await expect(vault.unlock(oldPassword)).rejects.toBeDefined();
        expect(storage.values.get(LOCAL_VAULT_ACTIVE_KEY)).toBe(tampered);

        const unknownVersion = JSON.stringify({ ...parsed, version: 99 });
        storage.values.set(LOCAL_VAULT_ACTIVE_KEY, unknownVersion);
        await expect(vault.unlock(oldPassword)).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
        expect(storage.values.get(LOCAL_VAULT_ACTIVE_KEY)).toBe(unknownVersion);
    });

    test("does not replace the old password when password-change commit fails", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("stable"));
        storage.failNextSetFor = LOCAL_VAULT_ACTIVE_KEY;

        await expect(vault.changePassword(newPassword)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
        const afterCrash = testVault(storage);
        expect(await afterCrash.unlock(oldPassword)).toEqual(payload("stable"));
    });

    test("reset removes active and pending data while raw backup remains ciphertext-only", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("sentinel-plain-secret"));
        const backup = await vault.rawBackup();

        expect(JSON.stringify(backup)).not.toContain("sentinel-plain-secret");
        await vault.reset();
        expect(await vault.inspect()).toEqual({ hasActive: false, hasPending: false });
        await expect(vault.unlock(oldPassword)).rejects.toMatchObject({ code: "NOT_SETUP" });
    });

    test("a failed reset stays unlocked and preserves active data", async () => {
        const storage = new MemoryStorage();
        const vault = testVault(storage);
        await vault.setup(oldPassword, payload("stable"));
        const active = storage.values.get(LOCAL_VAULT_ACTIVE_KEY);
        storage.failNextRemoveFor = LOCAL_VAULT_ACTIVE_KEY;

        await expect(vault.reset()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
        expect(vault.isUnlocked()).toBe(true);
        expect(vault.read()).toEqual(payload("stable"));
        expect(storage.values.get(LOCAL_VAULT_ACTIVE_KEY)).toBe(active);
    });
});

function payload(secret: string): TestPayload {
    return { schemaVersion: 1, secret };
}

function validateTestPayload(value: unknown): TestPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "schemaVersion,secret" || record.schemaVersion !== 1 || typeof record.secret !== "string") throw new Error("Invalid payload");
    return { schemaVersion: 1, secret: record.secret };
}

function testVault(storage: LocalVaultStorage) {
    return createLocalVault({ storage, validatePayload: validateTestPayload, sessionLock: { acquire: async () => () => undefined } });
}

class MemoryStorage implements LocalVaultStorage {
    readonly values = new Map<string, string>();
    failNextSetFor = "";
    writeThenFailNextSetFor = "";
    failNextRemoveFor = "";
    corruptNextReadFor = "";
    delayMs = 0;

    async getItem(key: string) {
        await this.delay();
        const value = this.values.get(key) ?? null;
        if (this.corruptNextReadFor === key && value !== null) {
            this.corruptNextReadFor = "";
            return `${value.slice(0, -2)}xx`;
        }
        return value;
    }

    async setItem(key: string, value: string) {
        await this.delay();
        if (this.failNextSetFor === key) {
            this.failNextSetFor = "";
            throw new Error("Injected set failure");
        }
        this.values.set(key, value);
        if (this.writeThenFailNextSetFor === key) {
            this.writeThenFailNextSetFor = "";
            throw new Error("Injected post-commit failure");
        }
    }

    async removeItem(key: string) {
        await this.delay();
        if (this.failNextRemoveFor === key) {
            this.failNextRemoveFor = "";
            throw new Error("Injected remove failure");
        }
        this.values.delete(key);
    }

    private async delay() {
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
}
