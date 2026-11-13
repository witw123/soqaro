"use client";

import { useCallback, useEffect, useState } from "react";
import type { AlistConfig, AlistTestResponse } from "@soqaro/shared";
import { soqaroApi } from "@/lib/network/soqaro-api";

export const alistStorageKey = "soqaro-alist-config-v1";
export const alistSessionTokenKey = "soqaro-alist-token-v1";
export const alistConfigChangeEvent = "soqaro-alist-config-changed";

let memoryAlistToken: string | undefined;

function readSessionToken(): string | undefined {
  if (memoryAlistToken) {
    return memoryAlistToken;
  }
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage?.getItem(alistSessionTokenKey)?.trim();
    if (raw) {
      memoryAlistToken = raw;
      return raw;
    }
  } catch {
    // Ignore restricted sessionStorage access
  }
  return undefined;
}

function writeSessionToken(token: string | undefined): void {
  const trimmed = token?.trim() || undefined;
  memoryAlistToken = trimmed;
  if (typeof window === "undefined") return;
  try {
    if (trimmed) {
      window.sessionStorage?.setItem(alistSessionTokenKey, trimmed);
    } else {
      window.sessionStorage?.removeItem(alistSessionTokenKey);
    }
  } catch {
    // Ignore restricted sessionStorage access
  }
}

export function getStoredAlistConfig(): AlistConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(alistStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AlistConfig>;
    if (parsed && typeof parsed.url === "string" && parsed.url.trim()) {
      const sanitized = {
        url: parsed.url.trim(),
        mountPath: parsed.mountPath?.trim() || "/Music"
      };
      if (typeof parsed.token === "string" && parsed.token.trim()) {
        // Strip any plaintext token previously stored in localStorage.
        localStorage.setItem(alistStorageKey, JSON.stringify(sanitized));
      }
      return {
        ...sanitized,
        token: readSessionToken()
      };
    }
  } catch {
    // Ignore invalid JSON
  }
  return null;
}

export function saveStoredAlistConfig(config: AlistConfig): void {
  if (typeof window === "undefined") return;
  const persistedConfig = {
    url: config.url.trim(),
    mountPath: config.mountPath?.trim() || "/Music"
  };
  localStorage.setItem(alistStorageKey, JSON.stringify(persistedConfig));
  writeSessionToken(config.token);
  const effectiveConfig: AlistConfig = {
    ...persistedConfig,
    token: config.token?.trim() || undefined
  };
  window.dispatchEvent(new CustomEvent(alistConfigChangeEvent, { detail: effectiveConfig }));
}

export function clearStoredAlistConfig(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(alistStorageKey);
  writeSessionToken(undefined);
  window.dispatchEvent(new CustomEvent(alistConfigChangeEvent, { detail: null }));
}

export function useAlistStorage() {
  const [config, setConfig] = useState<AlistConfig | null>(() => getStoredAlistConfig());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AlistTestResponse | null>(null);

  useEffect(() => {
    const handleStorage = () => {
      setConfig(getStoredAlistConfig());
    };
    window.addEventListener(alistConfigChangeEvent, handleStorage);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(alistConfigChangeEvent, handleStorage);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const saveConfig = useCallback((newConfig: AlistConfig) => {
    saveStoredAlistConfig(newConfig);
    setConfig(newConfig);
    setTestResult(null);
  }, []);

  const removeConfig = useCallback(() => {
    clearStoredAlistConfig();
    setConfig(null);
    setTestResult(null);
  }, []);

  const testConnection = useCallback(async (targetConfig?: AlistConfig): Promise<AlistTestResponse> => {
    const activeConfig = targetConfig ?? config;
    if (!activeConfig?.url) {
      const emptyRes: AlistTestResponse = { ok: false, message: "请先填写 Alist 服务地址。" };
      setTestResult(emptyRes);
      return emptyRes;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await soqaroApi.testAlistConnection({
        url: activeConfig.url,
        mountPath: activeConfig.mountPath || "/Music",
        token: activeConfig.token
      });
      setTestResult(res);
      return res;
    } catch (err) {
      const failRes: AlistTestResponse = {
        ok: false,
        message: `测试请求失败: ${err instanceof Error ? err.message : String(err)}`
      };
      setTestResult(failRes);
      return failRes;
    } finally {
      setTesting(false);
    }
  }, [config]);

  return {
    config,
    isConfigured: Boolean(config?.url),
    testing,
    testResult,
    saveConfig,
    removeConfig,
    testConnection,
    setTestResult
  };
}
