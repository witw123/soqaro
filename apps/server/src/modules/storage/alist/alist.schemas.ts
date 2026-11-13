import { z } from "zod";

const MAX_ALIST_URL_LENGTH = 2048;
const MAX_ALIST_PATH_LENGTH = 1024;

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isSafeAlistPath(raw: string): boolean {
  if (raw.includes("\0") || raw.includes("\\")) {
    return false;
  }
  const segments = raw.split("/");
  return !segments.some((segment) => segment === "." || segment === "..");
}

const alistUrlSchema = z
  .string()
  .trim()
  .max(MAX_ALIST_URL_LENGTH, "Alist 服务地址过长")
  .url("Alist 服务地址必须是有效的 URL")
  .refine(isSafeHttpUrl, "Alist 服务地址仅支持不含认证信息的 http/https URL");

const alistPathSchema = z
  .string()
  .max(MAX_ALIST_PATH_LENGTH, "Alist 路径过长")
  .refine(isSafeAlistPath, "Alist 路径包含非法字符或目录穿越片段");

export const alistTestConfigBodySchema = z
  .object({
    url: alistUrlSchema,
    mountPath: alistPathSchema.pipe(z.string().min(1, "挂载路径不能为空")).default("/"),
    token: z.string().max(1024).optional()
  })
  .strict();

export const alistListDirectoryBodySchema = z
  .object({
    url: alistUrlSchema,
    path: alistPathSchema.default("/"),
    token: z.string().max(1024).optional(),
    page: z.coerce.number().int().positive().default(1),
    perPage: z.coerce.number().int().min(1).max(200).default(100),
    refresh: z.boolean().default(false)
  })
  .strict();

export const alistGetFileBodySchema = z
  .object({
    url: alistUrlSchema,
    path: alistPathSchema.pipe(z.string().min(1, "文件路径不能为空")),
    token: z.string().max(1024).optional()
  })
  .strict();

export const alistStreamQuerySchema = z
  .object({
    url: alistUrlSchema
  })
  .strict();
