import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";

const logger = new Logger("BilibiliWbi");

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

// 兜底 WBI Key（当 nav 接口短暂不可用时使用）
const FALLBACK_IMG_KEY = "7cd084941338484aae1ad9425b84077c";
const FALLBACK_SUB_KEY = "4932caff0ff746eab6f01bf08b70ac45";

export function getMixinKey(orig: string): string {
  let temp = "";
  for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
    temp += orig[MIXIN_KEY_ENC_TAB[i]];
  }
  return temp.slice(0, 32);
}

export function encWbi(
  params: Record<string, string | number | boolean>,
  imgKey: string,
  subKey: string
): string {
  const mixinKey = getMixinKey(imgKey + subKey);
  const currTime = Math.round(Date.now() / 1000);
  const newParams: Record<string, string | number | boolean> = {
    ...params,
    wts: currTime
  };

  // 参数按字典序排序
  const keys = Object.keys(newParams).sort();
  const queryParts: string[] = [];

  for (const k of keys) {
    const rawVal = String(newParams[k]);
    // 过滤 B 站 WBI 规则要求的字符: ! ' ( ) *
    const cleanVal = rawVal.replace(/[!'()*]/g, "");
    queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(cleanVal)}`);
  }

  const queryStr = queryParts.join("&");
  const wbiSign = createHash("md5")
    .update(queryStr + mixinKey)
    .digest("hex");

  return `${queryStr}&w_rid=${wbiSign}`;
}

export class BilibiliWbiSigner {
  private static cachedImgKey: string | null = null;
  private static cachedSubKey: string | null = null;
  private static keysExpiresAt = 0;

  /** Clear cached WBI signing keys so the next call fetches fresh keys. */
  static invalidateCache(): void {
    this.cachedImgKey = null;
    this.cachedSubKey = null;
    this.keysExpiresAt = 0;
  }

  /**
   * 获取并缓存 WBI Key
   */
  static async getWbiKeys(cookie?: string): Promise<{ imgKey: string; subKey: string }> {
    const now = Date.now();
    if (this.cachedImgKey && this.cachedSubKey && now < this.keysExpiresAt) {
      return { imgKey: this.cachedImgKey, subKey: this.cachedSubKey };
    }

    try {
      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://www.bilibili.com/"
      };
      if (cookie) {
        headers.Cookie = cookie;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let res: Response;
      try {
        res = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const json = (await res.json()) as {
          code: number;
          data?: {
            wbi_img?: {
              img_url?: string;
              sub_url?: string;
            };
          };
        };

        const imgUrl = json.data?.wbi_img?.img_url;
        const subUrl = json.data?.wbi_img?.sub_url;

        if (imgUrl && subUrl) {
          const imgKey = imgUrl.slice(imgUrl.lastIndexOf("/") + 1, imgUrl.lastIndexOf("."));
          const subKey = subUrl.slice(subUrl.lastIndexOf("/") + 1, subUrl.lastIndexOf("."));

          if (imgKey && subKey) {
            this.cachedImgKey = imgKey;
            this.cachedSubKey = subKey;
            // 缓存 6 小时
            this.keysExpiresAt = now + 6 * 3600 * 1000;
            return { imgKey, subKey };
          }
        }
      }
    } catch (err) {
      logger.warn(`Failed to fetch latest WBI keys from nav: ${err instanceof Error ? err.message : String(err)}, using fallback keys`);
    }

    return {
      imgKey: this.cachedImgKey ?? FALLBACK_IMG_KEY,
      subKey: this.cachedSubKey ?? FALLBACK_SUB_KEY
    };
  }

  /**
   * 对请求参数进行 WBI 签名，返回完整的 query 字符串
   */
  static async sign(
    params: Record<string, string | number | boolean>,
    cookie?: string
  ): Promise<string> {
    const { imgKey, subKey } = await this.getWbiKeys(cookie);
    return encWbi(params, imgKey, subKey);
  }
}
