import { Injectable } from "@nestjs/common";
import { isValidNeteaseEncryptionKey } from "../../../common/config/runtime-config";
import { createProviderCookieCipher } from "../provider-cookie-crypto";

@Injectable()
export class NeteaseCryptoService {
  private readonly cipher = createProviderCookieCipher({
    envVarName: "NETEASE_COOKIE_ENCRYPTION_KEY",
    isValidKey: isValidNeteaseEncryptionKey,
    invalidKeyMessage:
      "NETEASE_COOKIE_ENCRYPTION_KEY must be a 32-byte hex or base64 key when NetEase is enabled.",
    invalidPayloadMessage: "Invalid NetEase account encryption payload."
  });

  encrypt(value: string, aad?: string) {
    return this.cipher.encrypt(value, aad);
  }

  decrypt(value: string, aad?: string) {
    return this.cipher.decrypt(value, aad);
  }
}
