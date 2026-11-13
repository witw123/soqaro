import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isValidQqMusicEncryptionKey } from "../../../common/config/runtime-config";

@Injectable()
export class QqMusicCryptoService {
  encrypt(value: string, aad?: string) {
    const key = resolveKey(); const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
  }
  decrypt(value: string, aad?: string) {
    const [version, iv, tag, ciphertext] = value.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid QQ Music account encryption payload.");
    const decipher = createDecipheriv("aes-256-gcm", resolveKey(), Buffer.from(iv, "base64url"));
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}
function resolveKey() {
  const value = process.env.QQMUSIC_COOKIE_ENCRYPTION_KEY?.trim();
  if (!value || !isValidQqMusicEncryptionKey(value)) throw new Error("QQMUSIC_COOKIE_ENCRYPTION_KEY must be a 32-byte hex or base64 key.");
  return /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
}
