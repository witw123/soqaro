import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  alistSessionTokenKey,
  alistStorageKey,
  clearStoredAlistConfig,
  getStoredAlistConfig,
  saveStoredAlistConfig
} from "./use-alist-storage";

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    }
  };
}

describe("use-alist-storage", () => {
  beforeEach(() => {
    const local = createStorageMock();
    const session = createStorageMock();
    vi.stubGlobal("window", {
      localStorage: local,
      sessionStorage: session,
      dispatchEvent: vi.fn(),
      CustomEvent: class CustomEvent {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      }
    });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("CustomEvent", (window as unknown as { CustomEvent: unknown }).CustomEvent);
    clearStoredAlistConfig();
  });

  it("never stores AList token in localStorage", () => {
    saveStoredAlistConfig({
      url: "https://alist.example.com",
      mountPath: "/Music",
      token: "super-secret-token"
    });

    const rawLocal = localStorage.getItem(alistStorageKey);
    expect(rawLocal).not.toBeNull();
    expect(rawLocal).not.toContain("super-secret-token");
    expect(JSON.parse(rawLocal!)).toEqual({
      url: "https://alist.example.com",
      mountPath: "/Music"
    });
    expect(sessionStorage.getItem(alistSessionTokenKey)).toBe("super-secret-token");
    expect(getStoredAlistConfig()).toEqual({
      url: "https://alist.example.com",
      mountPath: "/Music",
      token: "super-secret-token"
    });
  });

  it("strips legacy plaintext token from localStorage on read", () => {
    localStorage.setItem(
      alistStorageKey,
      JSON.stringify({
        url: "https://alist.example.com",
        mountPath: "/Audio",
        token: "legacy-leaked-token"
      })
    );

    const cfg = getStoredAlistConfig();
    expect(cfg).toEqual({
      url: "https://alist.example.com",
      mountPath: "/Audio",
      token: undefined
    });
    expect(localStorage.getItem(alistStorageKey)).not.toContain("legacy-leaked-token");
  });
});
