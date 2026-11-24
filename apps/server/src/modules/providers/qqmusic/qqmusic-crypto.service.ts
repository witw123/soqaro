import { Injectable } from "@nestjs/common";
import { isValidQqMusicEncryptionKey } from "../../../common/config/runtime-config";
import { createProviderCookieCipher } from "../provider-cookie-crypto";

@Injectable()
export class QqMusicCryptoService {
  private readonly cipher = createProviderCookieCipher({
    envVarName: "QQMUSIC_COOKIE_ENCRYPTION_KEY",
    isValidKey: isValidQqMusicEncryptionKey,
    invalidKeyMessage:
      "QQMUSIC_COOKIE_ENCRYPTION_KEY must be a 32-byte hex or base64 key.",
    invalidPayloadMessage: "Invalid QQ Music account encryption payload."
  });

  encrypt(value: string, aad?: string) {
    return this.cipher.encrypt(value, aad);
  }

  decrypt(value: string, aad?: string) {
    return this.cipher.decrypt(value, aad);
  }
}
