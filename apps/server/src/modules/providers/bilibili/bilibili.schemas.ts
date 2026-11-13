import { z } from "zod";

export const bilibiliSearchQuerySchema = z
  .object({
    keyword: z.string().trim().min(1).max(100),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(10),
    tid: z.coerce.number().int().positive().optional()
  })
  .strict();

export const bilibiliResolveAudioQuerySchema = z
  .object({
    cid: z.coerce.number().int().positive().optional(),
    quality: z.enum(["standard", "high", "exhigh"]).optional()
  })
  .strict();

export const bilibiliBvidSchema = z
  .string()
  .trim()
  .regex(/^(BV[a-zA-Z0-9]{10}|av\d+)$/i, "无效的 B 站视频 ID (支持 BV 号或 av 号)");

export const bilibiliImportFavoriteBodySchema = z
  .object({
    url: z.string().trim().min(1, "请输入收藏夹链接或 ID")
  })
  .strict();

export const bilibiliImportFavoriteQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(30)
  })
  .strict();

export const bilibiliRankingQuerySchema = z
  .object({
    subType: z.string().trim().optional()
  })
  .strict();
