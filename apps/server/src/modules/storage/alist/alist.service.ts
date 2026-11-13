import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { posix as posixPath } from "node:path";
import type {
  AlistAudioItem,
  AlistFileItem,
  AlistListResponse,
  AlistTestResponse
} from "@soqaro/shared";
import { fetchProviderUrl } from "../../providers/provider-fetch";

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".aac",
  ".opus",
  ".ape",
  ".dsf",
  ".dff"
]);

const DEFAULT_ALIST_MAX_STREAM_BYTES = 200 * 1024 * 1024;
const ALIST_REQUEST_TIMEOUT_MS = 15_000;
const BYTE_RANGE_HEADER_PATTERN = /^bytes=(\d+-\d*|\d*-\d+)$/i;

function resolveAlistMaxStreamBytes(): number {
  const configured = Number(process.env.ALIST_MAX_STREAM_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_ALIST_MAX_STREAM_BYTES;
}

function assertSafeAlistUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpException("Alist URL 格式无效。", HttpStatus.BAD_REQUEST);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpException("Alist 仅支持 http/https 协议地址。", HttpStatus.BAD_REQUEST);
  }
  if (parsed.username || parsed.password) {
    throw new HttpException("Alist URL 不允许包含认证信息。", HttpStatus.BAD_REQUEST);
  }
  return parsed;
}

function normalizeAlistPath(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\")) {
    throw new HttpException("Alist 路径包含非法字符。", HttpStatus.BAD_REQUEST);
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new HttpException("Alist 路径不允许包含目录穿越片段。", HttpStatus.BAD_REQUEST);
  }
  const prefixed = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const normalized = posixPath.normalize(prefixed);
  if (!normalized.startsWith("/")) {
    throw new HttpException("Alist 路径规范化失败。", HttpStatus.BAD_REQUEST);
  }
  return normalized;
}

function isSafeEntryName(name: string): boolean {
  if (!name || name === "." || name === "..") {
    return false;
  }
  return !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function resolveSafeAlistStreamMime(contentType: string | null): string | null {
  if (!contentType?.trim()) {
    return "application/octet-stream";
  }
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType) {
    return "application/octet-stream";
  }
  if (
    mimeType.startsWith("audio/") ||
    mimeType === "application/ogg" ||
    mimeType === "application/octet-stream" ||
    mimeType === "text/plain"
  ) {
    return mimeType;
  }
  return null;
}

const isAllowedAlistHost = () => true;

@Injectable()
export class AlistService {
  private readonly logger = new Logger(AlistService.name);

  async testConnection(
    baseUrl: string,
    mountPath: string,
    token?: string
  ): Promise<AlistTestResponse> {
    try {
      const normalizedUrl = assertSafeAlistUrl(baseUrl).toString().replace(/\/+$/, "");
      const normalizedMount = normalizeAlistPath(mountPath || "/");
      const res = await this.callAlistApi(
        normalizedUrl,
        "/api/fs/list",
        {
          path: normalizedMount,
          page: 1,
          per_page: 1,
          refresh: true
        },
        token
      );

      if (res.code === 200) {
        return { ok: true, message: "Alist 服务连接成功，目录可正常访问。" };
      }
      this.logger.warn(`Alist testConnection returned non-200 code=${res.code}`);
      return {
        ok: false,
        message: `Alist 服务返回异常状态 (${res.code})，请检查挂载路径或访问凭证。`
      };
    } catch (err) {
      if (err instanceof HttpException) {
        return { ok: false, message: err.message };
      }
      this.logger.warn(
        `Alist testConnection failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        ok: false,
        message: "无法连接到 Alist 服务，请检查服务地址、网络连通性或访问凭证。"
      };
    }
  }

  async listDirectory(
    baseUrl: string,
    dirPath: string,
    page = 1,
    perPage = 100,
    refresh = false,
    token?: string
  ): Promise<AlistListResponse> {
    const normalizedUrl = assertSafeAlistUrl(baseUrl).toString().replace(/\/+$/, "");
    const normalizedPath = normalizeAlistPath(dirPath || "/");

    const res = await this.callAlistApi<{ content?: AlistFileItem[]; total?: number }>(
      normalizedUrl,
      "/api/fs/list",
      {
        path: normalizedPath,
        page,
        per_page: perPage,
        refresh
      },
      token
    );

    if (res.code !== 200) {
      throw new HttpException(
        `Alist 目录读取失败 (${res.code})`,
        HttpStatus.BAD_GATEWAY
      );
    }

    const content: AlistFileItem[] = res.data?.content ?? [];
    const directories: string[] = [];
    const audioFiles: AlistFileItem[] = [];
    const lrcFileNames = new Set<string>();

    for (const item of content) {
      if (!isSafeEntryName(item.name)) {
        continue;
      }

      if (item.isDir) {
        directories.push(item.name);
        continue;
      }

      const lowerName = item.name.toLowerCase();
      if (lowerName.endsWith(".lrc")) {
        // 记录歌词文件名（不含扩展名）
        lrcFileNames.add(item.name.slice(0, -4).toLowerCase());
        continue;
      }

      const dotIndex = lowerName.lastIndexOf(".");
      if (dotIndex > 0) {
        const ext = lowerName.slice(dotIndex);
        if (AUDIO_EXTENSIONS.has(ext)) {
          audioFiles.push(item);
        }
      }
    }

    const items: AlistAudioItem[] = audioFiles.map((file) => {
      const dotIndex = file.name.lastIndexOf(".");
      const baseName = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
      const ext = dotIndex > 0 ? file.name.slice(dotIndex + 1).toLowerCase() : "";

      // 尝试按 "歌手 - 歌名" 格式拆分
      let artist = "未知歌手";
      let title = baseName;
      if (baseName.includes(" - ")) {
        const parts = baseName.split(" - ");
        artist = parts[0]?.trim() || "未知歌手";
        title = parts.slice(1).join(" - ").trim() || baseName;
      }

      const cleanDirPath = normalizedPath.endsWith("/")
        ? normalizedPath.slice(0, -1)
        : normalizedPath;
      const filePath = `${cleanDirPath}/${file.name}`;

      const hasLrc = lrcFileNames.has(baseName.toLowerCase());
      const lrcPath = hasLrc ? `${cleanDirPath}/${baseName}.lrc` : null;

      return {
        path: filePath,
        name: file.name,
        title,
        artist,
        album: null,
        sizeBytes: file.size,
        ext,
        lrcPath
      };
    });

    return {
      total: res.data?.total ?? items.length,
      items,
      directories,
      currentPath: normalizedPath
    };
  }

  async getFileDetail(
    baseUrl: string,
    filePath: string,
    token?: string
  ): Promise<{ rawUrl: string; size: number; name: string }> {
    const normalizedUrl = assertSafeAlistUrl(baseUrl).toString().replace(/\/+$/, "");
    const normalizedPath = normalizeAlistPath(filePath);

    const res = await this.callAlistApi<{ raw_url?: string; size?: number; name?: string }>(
      normalizedUrl,
      "/api/fs/get",
      {
        path: normalizedPath
      },
      token
    );

    if (res.code !== 200 || !res.data?.raw_url) {
      throw new HttpException(
        `获取 Alist 文件直链失败 (${res.code})`,
        HttpStatus.BAD_GATEWAY
      );
    }

    const safeRawUrl = assertSafeAlistUrl(res.data.raw_url).toString();
    const safeName = res.data.name && isSafeEntryName(res.data.name) ? res.data.name : "";

    return {
      rawUrl: safeRawUrl,
      size: res.data.size ?? 0,
      name: safeName
    };
  }

  async fetchAudioStream(
    rawUrl: string,
    range?: string
  ): Promise<{
    status: number;
    mimeType: string;
    maxBytes: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array> | null;
  }> {
    const safeUrl = assertSafeAlistUrl(rawUrl).toString();
    const headers: Record<string, string> = {
      "User-Agent": "Soqaro/1.0 (Alist Stream Client)"
    };
    if (range !== undefined) {
      const normalizedRange = range.trim();
      if (!BYTE_RANGE_HEADER_PATTERN.test(normalizedRange)) {
        throw new HttpException("Range 请求头格式无效。", HttpStatus.BAD_REQUEST);
      }
      headers.Range = normalizedRange;
    }

    const res = await fetchProviderUrl(
      new URL(safeUrl),
      { headers },
      ALIST_REQUEST_TIMEOUT_MS,
      isAllowedAlistHost,
      { allowHttp: true, maxRedirects: 3 }
    );

    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      throw new HttpException(
        `Alist 音频流请求失败 (${res.status})`,
        HttpStatus.BAD_GATEWAY
      );
    }

    const mimeType = resolveSafeAlistStreamMime(res.headers.get("content-type"));
    if (!mimeType) {
      await res.body?.cancel().catch(() => {});
      throw new HttpException(
        "Alist 上游响应的媒体类型不受支持。",
        HttpStatus.UNSUPPORTED_MEDIA_TYPE
      );
    }

    const maxBytes = resolveAlistMaxStreamBytes();
    const contentLengthHeader = res.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new HttpException(
        "Alist 音频文件超出允许的最大传输限制。",
        HttpStatus.PAYLOAD_TOO_LARGE
      );
    }

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of res.headers.entries()) {
      responseHeaders[key.toLowerCase()] = value;
    }

    return {
      status: res.status,
      mimeType,
      maxBytes,
      headers: responseHeaders,
      body: res.body
    };
  }

  private async callAlistApi<T = Record<string, unknown>>(
    baseUrl: string,
    endpoint: string,
    body: Record<string, unknown>,
    token?: string
  ): Promise<{ code: number; message: string; data?: T }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (token) {
      headers.Authorization = token;
    }

    const res = await fetchProviderUrl(
      new URL(`${baseUrl}${endpoint}`),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      },
      ALIST_REQUEST_TIMEOUT_MS,
      isAllowedAlistHost,
      { allowHttp: true, maxRedirects: 0 }
    );

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpException(
        `Alist 服务响应异常 (${res.status})`,
        HttpStatus.BAD_GATEWAY
      );
    }

    return res.json() as Promise<{ code: number; message: string; data?: T }>;
  }
}
