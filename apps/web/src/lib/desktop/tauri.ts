/**
 * Thin helpers for talking to the Tauri desktop shell. Everything degrades to
 * a no-op in plain browsers so the same bundle serves web, Capacitor mobile,
 * and the Tauri desktop window.
 */

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>> | undefined>;
};

export function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  const win = window as unknown as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(win.__TAURI__ || win.__TAURI_INTERNALS__);
}

/** True inside the Capacitor Android/iOS shell (injected Capacitor global). */
export function isCapacitorRuntime() {
  if (typeof window === "undefined") return false;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

export function capacitorPlugin(name: string) {
  if (typeof window === "undefined") return undefined;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return capacitor?.Plugins?.[name];
}

export async function invokeTauri<T = void>(
  command: string,
  args?: Record<string, unknown>
): Promise<T | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }
  const win = window as unknown as {
    __TAURI__?: {
      core?: {
        invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    __TAURI_INTERNALS__?: {
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      core?: {
        invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const invoke =
    win.__TAURI__?.core?.invoke ??
    win.__TAURI__?.invoke ??
    win.__TAURI_INTERNALS__?.invoke ??
    win.__TAURI_INTERNALS__?.core?.invoke;
  if (!invoke) {
    return undefined;
  }
  try {
    return (await invoke(command, args)) as T;
  } catch (error) {
    // Surface shell failures in the console; silent failures made toggle
    // buttons look dead during real-device testing.
    console.warn(`[tauri] invoke "${command}" failed:`, error);
    return undefined;
  }
}

export async function listenTauri<T = unknown>(
  event: string,
  handler: (payload: T) => void
): Promise<(() => void) | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }
  const win = window as unknown as {
    __TAURI__?: {
      event?: {
        listen?: (
          event: string,
          handler: (e: { payload: T }) => void
        ) => Promise<() => void>;
      };
      listen?: (
        event: string,
        handler: (e: { payload: T }) => void
      ) => Promise<() => void>;
    };
    __TAURI_INTERNALS__?: {
      event?: {
        listen?: (
          event: string,
          handler: (e: { payload: T }) => void
        ) => Promise<() => void>;
      };
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      transformCallback?: (callback: (response: unknown) => void, once?: boolean) => number;
      core?: {
        invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback?: (callback: (response: unknown) => void, once?: boolean) => number;
      };
    };
  };
  const listen =
    win.__TAURI__?.event?.listen ??
    win.__TAURI__?.listen ??
    win.__TAURI_INTERNALS__?.event?.listen;
  if (listen) {
    try {
      return await listen(event, (e) => handler(e.payload));
    } catch (error) {
      console.warn(`[tauri] listen "${event}" failed:`, error);
      return undefined;
    }
  }

  const invoke = win.__TAURI_INTERNALS__?.invoke ?? win.__TAURI_INTERNALS__?.core?.invoke;
  const transformCallback =
    win.__TAURI_INTERNALS__?.core?.transformCallback ??
    win.__TAURI_INTERNALS__?.transformCallback;
  if (!invoke || !transformCallback) {
    return undefined;
  }
  try {
    const callbackId = transformCallback((response: unknown) => {
      const data = response as { payload?: T } | undefined;
      if (data && "payload" in data) {
        handler(data.payload as T);
      }
    });
    const eventId = await invoke("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler: callbackId
    });
    return () => {
      void invoke("plugin:event|unlisten", { event, eventId }).catch(() => undefined);
    };
  } catch (error) {
    console.warn(`[tauri] listen "${event}" failed:`, error);
    return undefined;
  }
}
