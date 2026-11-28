import "dotenv/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
    const value = process.env.MAL_TOKEN_KEY ?? "";
    if (!/^[a-fA-F0-9]{64}$/.test(value)) {
        throw new Error("Set MAL_TOKEN_KEY to a 64-character hexadecimal key in .env");
    }
    return Buffer.from(value, "hex");
}

export function checkTokenKey() { key(); }

export function encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptToken(value: string): string {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted MAL token");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
