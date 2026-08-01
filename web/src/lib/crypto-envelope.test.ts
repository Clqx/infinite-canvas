import { describe, expect, test } from "bun:test";

import { CryptoEnvelopeError, MAX_ENVELOPE_BYTES, PBKDF2_ITERATIONS, createEnvelopeSession, openWithPassword, parseCryptoEnvelope, sealWithPassword, serializeCryptoEnvelope } from "./crypto-envelope";

type TestPayload = { schemaVersion: 1; secret: string };

const password = "correct horse battery staple";

describe("crypto envelope", () => {
    test("round-trips Unicode JSON with the required algorithms", async () => {
        const payload = { schemaVersion: 1 as const, secret: "API key / unicode: \u5bc6\u94a5" };
        const envelope = await sealWithPassword(password, payload, "local-vault");

        expect(envelope.version).toBe(1);
        expect(envelope.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS });
        expect(fromBase64(envelope.kdf.salt)).toHaveLength(16);
        expect(envelope.cipher).toMatchObject({ name: "AES-GCM", keyLength: 256 });
        expect(fromBase64(envelope.cipher.iv)).toHaveLength(12);
        expect(await openWithPassword(password, serializeCryptoEnvelope(envelope), "local-vault", validateTestPayload)).toEqual(payload);
    });

    test("uses a fresh salt per password session and a fresh IV per write", async () => {
        const payload = { schemaVersion: 1 as const, secret: "same value" };
        const firstSession = await createEnvelopeSession(password);
        const [first, second] = await Promise.all([firstSession.seal(payload, "local-vault"), firstSession.seal(payload, "local-vault")]);
        const otherSession = await createEnvelopeSession(password);
        const third = await otherSession.seal(payload, "local-vault");

        expect(first.kdf.salt).toBe(second.kdf.salt);
        expect(first.cipher.iv).not.toBe(second.cipher.iv);
        expect(first.ciphertext).not.toBe(second.ciphertext);
        expect(first.kdf.salt).not.toBe(third.kdf.salt);
    });

    test("does not distinguish a wrong password from authenticated-data tampering", async () => {
        const envelope = await sealWithPassword(password, { schemaVersion: 1, secret: "keep me" }, "local-vault");
        await expect(openWithPassword("wrong password", envelope, "local-vault", validateTestPayload)).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });

        const ciphertext = fromBase64(envelope.ciphertext);
        ciphertext[0] ^= 1;
        const tampered = { ...envelope, ciphertext: toBase64(ciphertext) };
        await expect(openWithPassword(password, tampered, "local-vault", validateTestPayload)).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    });

    test("rejects unknown versions, extra fields, wrong use, and malformed payload schemas", async () => {
        const envelope = await sealWithPassword(password, { schemaVersion: 1, secret: "value" }, "local-vault");
        expect(() => parseCryptoEnvelope({ ...envelope, version: 2 })).toThrow(CryptoEnvelopeError);
        try {
            parseCryptoEnvelope({ ...envelope, version: 2 });
        } catch (error) {
            expect(error).toMatchObject({ code: "UNSUPPORTED_VERSION" });
        }
        expect(() => parseCryptoEnvelope({ ...envelope, unexpected: true })).toThrow(CryptoEnvelopeError);
        expect(() => parseCryptoEnvelope(envelope, "config-export")).toThrow(CryptoEnvelopeError);
        await expect(
            openWithPassword(password, envelope, "local-vault", () => {
                throw new Error("invalid schema");
            }),
        ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    });

    test("rejects serialized envelopes before parsing when they exceed the input limit", () => {
        try {
            parseCryptoEnvelope("x".repeat(MAX_ENVELOPE_BYTES + 1));
            throw new Error("Expected oversized envelope to be rejected");
        } catch (error) {
            expect(error).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        }
    });
});

function validateTestPayload(value: unknown): TestPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "schemaVersion,secret" || record.schemaVersion !== 1 || typeof record.secret !== "string") throw new Error("Invalid payload");
    return { schemaVersion: 1, secret: record.secret };
}

function fromBase64(value: string) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array) {
    return btoa(String.fromCharCode(...value));
}
