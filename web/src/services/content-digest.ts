import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export async function sha256Blob(blob: Blob) {
    const digest = sha256.create();
    const reader = blob.stream().getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            digest.update(value);
        }
    } finally {
        reader.releaseLock();
    }
    return bytesToHex(digest.digest());
}

export function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
