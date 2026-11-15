import { describe, expect, it } from "vitest";
import { errorCodes } from "@soqaro/shared";
import { SoqaroApiError } from "@/lib/network/soqaro-api";
import { toProviderImportErrorMessage } from "./upload-import-helpers";

describe("toProviderImportErrorMessage", () => {
  it("translates structured Bilibili and internal errors into Chinese guidance", () => {
    expect(
      toProviderImportErrorMessage(new SoqaroApiError("Bilibili service unavailable.", errorCodes.bilibiliUnavailable))
    ).toBe("B 站音频服务暂时不可用，请稍后重试。");

    expect(
      toProviderImportErrorMessage(new SoqaroApiError("missing stream", errorCodes.bilibiliTrackNotFound))
    ).toBe("未找到可播放的 B 站音频流，可能受限于视频状态或分 P 权限。");

    expect(
      toProviderImportErrorMessage(new SoqaroApiError("Internal server error.", errorCodes.internal))
    ).toBe("服务器处理歌曲导入时出现异常，请稍后重试。");

    expect(toProviderImportErrorMessage(new Error("Internal server error."))).toBe(
      "服务器处理请求失败，请稍后重试。"
    );
  });
});
