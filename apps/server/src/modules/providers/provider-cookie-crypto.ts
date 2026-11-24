import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const cipherAlgorithm = "aes-256-gcm";
const encodingVersion = "v1";

/** Builds a shared AES-256-GCM cookie cipher parameterized per provider key config. */
export function createProviderCookieCipher(options: {
  envVarName: string;
  isValidKey: (value: string) => boolean;
  invalidKeyMessage: string;
  invalidPayloadMessage: string;
}) {
  const resolveKey = () => {
    const value = process.env[options.envVarName]?.trim();
    if (!value || !options.isValidKey(value)) {
      throw new Error(options.invalidKeyMessage);
    }
    return /^[a-f0-9]{64}$/i.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
  };

  return {
    encrypt(value: string, aad?: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(cipherAlgorithm, resolveKey(), iv);
      if (aad !== undefined) {
        cipher.setAAD(Buffer.from(aad, "utf8"));
      }
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return [
        encodingVersion,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url")
      ].join(":");
    },
    decrypt(value: string, aad?: string) {
      const [version, ivValue, tagValue, ciphertextValue] = value.split(":");
      if (version !== encodingVersion || !ivValue || !tagValue || !ciphertextValue) {
        throw new Error(options.invalidPayloadMessage);
      }
      const decipher = createDecipheriv(
        cipherAlgorithm,
        resolveKey(),
        Buffer.from(ivValue, "base64url")
      );
      if (aad !== undefined) {
        decipher.setAAD(Buffer.from(aad, "utf8"));
      }
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}
