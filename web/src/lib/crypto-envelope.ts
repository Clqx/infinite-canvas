const APP_ID = "infinite-canvas" as const;
const ENVELOPE_VERSION = 1 as const;
const KDF_NAME = "PBKDF2" as const;
const KDF_HASH = "SHA-256" as const;
const CIPHER_NAME = "AES-GCM" as const;
const KEY_LENGTH_BITS = 256 as const;
const AUTH_TAG_BYTES = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MAX_PASSWORD_BYTES = 1024;

export const PBKDF2_ITERATIONS = 600_000;
export const MAX_ENVELOPE_BYTES = 6 * 1024 * 1024;
export const MAX_PLAINTEXT_BYTES = 5 * 1024 * 1024;

export type CryptoEnvelopeKind = "local-vault" | "config-export";

export type CryptoEnvelopeV1 = {
    app: typeof APP_ID;
    kind: CryptoEnvelopeKind;
    version: typeof ENVELOPE_VERSION;
    kdf: {
        name: typeof KDF_NAME;
        hash: typeof KDF_HASH;
        iterations: number;
        salt: string;
    };
    cipher: {
        name: typeof CIPHER_NAME;
        keyLength: typeof KEY_LENGTH_BITS;
        iv: string;
    };
    ciphertext: string;
};

export type CryptoEnvelopeErrorCode = "CRYPTO_UNAVAILABLE" | "INVALID_PASSWORD" | "INVALID_ENVELOPE" | "UNSUPPORTED_VERSION" | "PAYLOAD_TOO_LARGE" | "DECRYPTION_FAILED";

export class CryptoEnvelopeError extends Error {
    readonly code: CryptoEnvelopeErrorCode;

    constructor(code: CryptoEnvelopeErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "CryptoEnvelopeError";
        this.code = code;
    }
}

export type EnvelopeSession = {
    readonly iterations: number;
    readonly salt: string;
    seal: (value: unknown, kind: CryptoEnvelopeKind) => Promise<CryptoEnvelopeV1>;
    open: <T>(envelope: CryptoEnvelopeV1 | string | unknown, kind: CryptoEnvelopeKind, validate: (value: unknown) => T) => Promise<T>;
};

export async function createEnvelopeSession(password: string): Promise<EnvelopeSession> {
    assertPassword(password);
    const saltBytes = randomBytes(SALT_BYTES);
    const key = await deriveKey(password, saltBytes, PBKDF2_ITERATIONS);
    return createSession(key, saltBytes, PBKDF2_ITERATIONS);
}

export async function unlockEnvelopeSession<T>(password: string, envelopeInput: CryptoEnvelopeV1 | string | unknown, kind: CryptoEnvelopeKind, validate: (value: unknown) => T): Promise<{ value: T; session: EnvelopeSession }> {
    assertPassword(password);
    const envelope = parseCryptoEnvelope(envelopeInput, kind);
    const saltBytes = decodeCanonicalBase64(envelope.kdf.salt, SALT_BYTES, "salt");
    const key = await deriveKey(password, saltBytes, envelope.kdf.iterations);
    const session = createSession(key, saltBytes, envelope.kdf.iterations);
    const value = await session.open(envelope, kind, validate);
    return { value, session };
}

export async function sealWithPassword(password: string, value: unknown, kind: CryptoEnvelopeKind): Promise<CryptoEnvelopeV1> {
    const session = await createEnvelopeSession(password);
    return session.seal(value, kind);
}

export async function openWithPassword<T>(password: string, envelope: CryptoEnvelopeV1 | string | unknown, kind: CryptoEnvelopeKind, validate: (value: unknown) => T): Promise<T> {
    return (await unlockEnvelopeSession(password, envelope, kind, validate)).value;
}

export function serializeCryptoEnvelope(envelope: CryptoEnvelopeV1): string {
    return JSON.stringify(parseCryptoEnvelope(envelope, envelope.kind));
}

export function parseCryptoEnvelope(input: CryptoEnvelopeV1 | string | unknown, expectedKind?: CryptoEnvelopeKind): CryptoEnvelopeV1 {
    let value: unknown = input;
    if (typeof input === "string") {
        if (utf8ByteLength(input) > MAX_ENVELOPE_BYTES) throw new CryptoEnvelopeError("PAYLOAD_TOO_LARGE", "Encrypted envelope is too large");
        try {
            value = JSON.parse(input) as unknown;
        } catch (error) {
            throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope is not valid JSON", { cause: error });
        }
    }

    if (!isStrictRecord(value, ["app", "kind", "version", "kdf", "cipher", "ciphertext"])) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope schema is invalid");
    if (value.app !== APP_ID) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope belongs to another application");
    if (value.version !== ENVELOPE_VERSION) throw new CryptoEnvelopeError("UNSUPPORTED_VERSION", "Encrypted envelope version is not supported");
    if (value.kind !== "local-vault" && value.kind !== "config-export") throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope kind is invalid");
    if (expectedKind && value.kind !== expectedKind) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope kind does not match its use");
    if (!isStrictRecord(value.kdf, ["name", "hash", "iterations", "salt"])) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope KDF schema is invalid");
    if (value.kdf.name !== KDF_NAME || value.kdf.hash !== KDF_HASH || value.kdf.iterations !== PBKDF2_ITERATIONS || typeof value.kdf.salt !== "string") throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope KDF parameters are invalid");
    decodeCanonicalBase64(value.kdf.salt, SALT_BYTES, "salt");
    if (!isStrictRecord(value.cipher, ["name", "keyLength", "iv"])) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope cipher schema is invalid");
    if (value.cipher.name !== CIPHER_NAME || value.cipher.keyLength !== KEY_LENGTH_BITS || typeof value.cipher.iv !== "string") throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope cipher parameters are invalid");
    decodeCanonicalBase64(value.cipher.iv, IV_BYTES, "IV");
    if (typeof value.ciphertext !== "string") throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope ciphertext is invalid");
    const ciphertext = decodeCanonicalBase64(value.ciphertext, undefined, "ciphertext");
    if (ciphertext.byteLength < AUTH_TAG_BYTES || ciphertext.byteLength > MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Encrypted envelope ciphertext size is invalid");
    return value as CryptoEnvelopeV1;
}

function createSession(key: CryptoKey, saltBytes: Uint8Array, iterations: number): EnvelopeSession {
    const salt = encodeBase64(saltBytes);
    return Object.freeze({
        iterations,
        salt,
        seal: async (value: unknown, kind: CryptoEnvelopeKind) => {
            const plaintext = serializePlaintext(value);
            const ivBytes = randomBytes(IV_BYTES);
            const metadata = createMetadata(kind, iterations, salt, encodeBase64(ivBytes));
            const crypto = requireCrypto();
            const encrypted = await crypto.subtle.encrypt(
                {
                    name: CIPHER_NAME,
                    iv: asArrayBuffer(ivBytes),
                    additionalData: asArrayBuffer(encodeUtf8(authenticatedMetadata(metadata))),
                    tagLength: AUTH_TAG_BYTES * 8,
                },
                key,
                asArrayBuffer(plaintext),
            );
            return { ...metadata, ciphertext: encodeBase64(new Uint8Array(encrypted)) };
        },
        open: async <T>(envelopeInput: CryptoEnvelopeV1 | string | unknown, kind: CryptoEnvelopeKind, validate: (value: unknown) => T) => {
            const envelope = parseCryptoEnvelope(envelopeInput, kind);
            if (envelope.kdf.iterations !== iterations || envelope.kdf.salt !== salt) throw new CryptoEnvelopeError("DECRYPTION_FAILED", "Password is incorrect or encrypted data is corrupted");
            const crypto = requireCrypto();
            try {
                const decrypted = await crypto.subtle.decrypt(
                    {
                        name: CIPHER_NAME,
                        iv: asArrayBuffer(decodeCanonicalBase64(envelope.cipher.iv, IV_BYTES, "IV")),
                        additionalData: asArrayBuffer(encodeUtf8(authenticatedMetadata(envelope))),
                        tagLength: AUTH_TAG_BYTES * 8,
                    },
                    key,
                    asArrayBuffer(decodeCanonicalBase64(envelope.ciphertext, undefined, "ciphertext")),
                );
                if (decrypted.byteLength > MAX_PLAINTEXT_BYTES) throw new CryptoEnvelopeError("PAYLOAD_TOO_LARGE", "Decrypted payload is too large");
                const decoded = decodeUtf8Strict(new Uint8Array(decrypted));
                const parsed = JSON.parse(decoded) as unknown;
                return validatePayload(parsed, validate);
            } catch (error) {
                if (error instanceof CryptoEnvelopeError && error.code === "PAYLOAD_TOO_LARGE") throw error;
                throw new CryptoEnvelopeError("DECRYPTION_FAILED", "Password is incorrect or encrypted data is corrupted", { cause: error });
            }
        },
    });
}

function createMetadata(kind: CryptoEnvelopeKind, iterations: number, salt: string, iv: string): Omit<CryptoEnvelopeV1, "ciphertext"> {
    return {
        app: APP_ID,
        kind,
        version: ENVELOPE_VERSION,
        kdf: { name: KDF_NAME, hash: KDF_HASH, iterations, salt },
        cipher: { name: CIPHER_NAME, keyLength: KEY_LENGTH_BITS, iv },
    };
}

function authenticatedMetadata(envelope: Omit<CryptoEnvelopeV1, "ciphertext"> | CryptoEnvelopeV1) {
    return JSON.stringify({ app: envelope.app, kind: envelope.kind, version: envelope.version, kdf: envelope.kdf, cipher: envelope.cipher });
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
    const crypto = requireCrypto();
    const passwordKey = await crypto.subtle.importKey("raw", asArrayBuffer(encodeUtf8(password)), KDF_NAME, false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: KDF_NAME, hash: KDF_HASH, salt: asArrayBuffer(salt), iterations }, passwordKey, { name: CIPHER_NAME, length: KEY_LENGTH_BITS }, false, ["encrypt", "decrypt"]);
}

function serializePlaintext(value: unknown) {
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch (error) {
        throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Payload is not JSON serializable", { cause: error });
    }
    if (serialized === undefined) throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Payload is not JSON serializable");
    const bytes = encodeUtf8(serialized);
    if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw new CryptoEnvelopeError("PAYLOAD_TOO_LARGE", "Payload is too large to encrypt");
    return bytes;
}

function validatePayload<T>(value: unknown, validate: (value: unknown) => T) {
    try {
        return validate(value);
    } catch (error) {
        throw new CryptoEnvelopeError("INVALID_ENVELOPE", "Decrypted payload schema is invalid", { cause: error });
    }
}

function assertPassword(password: string) {
    if (typeof password !== "string" || !password.length || utf8ByteLength(password) > MAX_PASSWORD_BYTES) throw new CryptoEnvelopeError("INVALID_PASSWORD", "Password is empty or too long");
}

function requireCrypto() {
    const crypto = globalThis.crypto;
    if (!crypto?.subtle || typeof crypto.getRandomValues !== "function") throw new CryptoEnvelopeError("CRYPTO_UNAVAILABLE", "Web Crypto is unavailable; use localhost or HTTPS");
    return crypto;
}

function randomBytes(length: number) {
    return requireCrypto().getRandomValues(new Uint8Array(length));
}

function encodeUtf8(value: string) {
    return new TextEncoder().encode(value);
}

function decodeUtf8Strict(value: Uint8Array) {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function utf8ByteLength(value: string) {
    return encodeUtf8(value).byteLength;
}

function encodeBase64(bytes: Uint8Array) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    return btoa(binary);
}

function decodeCanonicalBase64(value: string, expectedLength: number | undefined, label: string) {
    if (!value.length || value.length > Math.ceil((MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES) / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        throw new CryptoEnvelopeError("INVALID_ENVELOPE", `Encrypted envelope ${label} is not canonical base64`);
    let binary: string;
    try {
        binary = atob(value);
    } catch (error) {
        throw new CryptoEnvelopeError("INVALID_ENVELOPE", `Encrypted envelope ${label} is not valid base64`, { cause: error });
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (expectedLength !== undefined && bytes.byteLength !== expectedLength) throw new CryptoEnvelopeError("INVALID_ENVELOPE", `Encrypted envelope ${label} has an invalid length`);
    if (encodeBase64(bytes) !== value) throw new CryptoEnvelopeError("INVALID_ENVELOPE", `Encrypted envelope ${label} is not canonical base64`);
    return bytes;
}

function isStrictRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function asArrayBuffer(bytes: Uint8Array) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
