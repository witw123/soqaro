import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { PersistentRoomRuntime } from "@/components/shell";
import "./globals.css";

const themeInitScript = `(() => {
  try {
    const raw = localStorage.getItem("soqaro-settings-v1");
    const value = raw ? JSON.parse(raw) : null;
    const validThemes = ["system","dark","light","sage-dark","sage-light","obsidian","midnight-dark","midnight-light","paper"];
    const preference = value && validThemes.includes(value.theme) ? value.theme : "dark";
    const sidebarCollapsed = !(value && value.layout && value.layout.sidebarCollapsed === false);
    const systemPrefersLight = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
    let resolved = preference;
    if (resolved === "system") {
      resolved = systemPrefersLight ? "light" : "dark";
    }
    const isDark = resolved === "dark" || resolved === "sage-dark" || resolved === "obsidian" || resolved === "midnight-dark";
    const themeMode = isDark ? "dark" : "light";
    const iconPacks = {
      dark: "studio",
      light: "studio",
      "sage-dark": "botanical",
      "sage-light": "botanical",
      obsidian: "noir",
      "midnight-dark": "blueprint",
      "midnight-light": "blueprint",
      paper: "editorial"
    };
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.dataset.iconPack = iconPacks[resolved] || "studio";
    document.documentElement.dataset.sidebarCollapsed = String(sidebarCollapsed);
    document.documentElement.style.colorScheme = themeMode;

    const metaColors = {
      dark: "#111113",
      light: "#fcfcfd",
      "sage-dark": "#0f1412",
      "sage-light": "#eff5f2",
      obsidian: "#070708",
      "midnight-dark": "#08101d",
      "midnight-light": "#eaf2fc",
      paper: "#f5efe3"
    };
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", metaColors[resolved] || (isDark ? "#111113" : "#fcfcfd"));

    const isLyricsWindow = Boolean(typeof window !== "undefined" && window.location && (window.location.pathname === "/desktop-lyrics" || (window.location.search && window.location.search.indexOf("window=desktop-lyrics") !== -1)));
    if (isLyricsWindow) {
      document.documentElement.dataset.lyricsWindow = "true";
      document.documentElement.style.background = "transparent";
    }
    if (!isLyricsWindow && value && value.layout && typeof value.layout.uiScale === "number" && isFinite(value.layout.uiScale)) {
      const scale = Math.min(2, Math.max(0.5, value.layout.uiScale));
      if (Math.abs(scale - 1) >= 0.001) {
        const tauriInvoke =
          (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
          window.__TAURI_INTERNALS__?.invoke;
        if (tauriInvoke) {
          tauriInvoke("set_ui_zoom", { scale }).catch(function (error) {
            console.error("[ui-scale] Failed to set desktop zoom:", error);
          });
          document.documentElement.style.setProperty("--ui-scale", String(scale));
          document.documentElement.dataset.uiScale = String(scale);
        }
      }
    }
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeMode = "dark";
    document.documentElement.style.colorScheme = "dark";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#0d0f12");
  }
})();`;

export const viewport: Viewport = {
  themeColor: "#09090b",
  // Cover mode is what makes env(safe-area-inset-*) report real values; the
  // Capacitor shell loads this page as a remote URL, so the shell's own
  // viewport meta never applies. Without it every inset padding in
  // globals.css (bottom navigation, floating player, room bottom inset) is
  // inert and content sits under the status bar / gesture bar.
  viewportFit: "cover"
};

// The Capacitor WebView offers no reachable devtools in release builds, so a
// client-side exception there is an opaque "Application error" page. Capture
// window-level errors, rejections, and console.error into an on-screen overlay
// — active only inside the native shell, invisible in plain browsers.
const shellErrorReporterScript = `(() => {
  try {
    if (!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform())) {
      return;
    }
    const serialize = (value) => {
      if (value instanceof Error) return value.stack || \`\${value.name}: \${value.message}\`;
      if (typeof value === "object" && value !== null) {
        try { return JSON.stringify(value); } catch { return String(value); }
      }
      return String(value);
    };
    const show = (heading, detail) => {
      let box = document.getElementById("shell-error-overlay");
      if (!box) {
        box = document.createElement("pre");
        box.id = "shell-error-overlay";
        box.setAttribute("role", "alert");
        box.style.cssText = "position:fixed;left:0;right:0;bottom:0;max-height:50%;overflow:auto;z-index:2147483647;margin:0;background:#2b0707;color:#ffb4b4;font:11px/1.45 monospace;padding:10px;white-space:pre-wrap;word-break:break-all;border-top:2px solid #ff5252;";
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent += (box.textContent ? "\\n\\n" : "") + heading + "\\n" + detail;
    };
    window.addEventListener("error", (event) => {
      const error = event.error;
      show(
        "[error]",
        error instanceof Error ? (error.stack || error.message) : \`\${event.message} @ \${event.filename}:\${event.lineno}\`
      );
    });
    window.addEventListener("unhandledrejection", (event) => {
      show("[unhandledrejection]", serialize(event.reason));
    });
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
      try {
        show("[console.error]", args.map(serialize).join(" "));
      } catch {}
      originalConsoleError(...args);
    };
  } catch {}
})();`;

export const metadata: Metadata = {
  title: "Soqaro",
  description: "与好友实时同步收听本地高保真音乐。Soqaro 通过房间状态同步和 WebRTC RTP Opus 媒体链路，提供浏览器优先的协作听歌体验。",
  keywords: ["Soqaro", "音乐房", "一起听歌", "共享队列", "高保真音乐", "实时协作"],
  manifest: "/manifest.webmanifest",
  referrer: "no-referrer"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="referrer" content="no-referrer" />
        <Script id="theme-init" strategy="beforeInteractive">{themeInitScript}</Script>
        <Script id="shell-error-reporter" strategy="beforeInteractive">{shellErrorReporterScript}</Script>
      </head>
      <body className="font-sans antialiased" suppressHydrationWarning>
        <PersistentRoomRuntime>{children}</PersistentRoomRuntime>
      </body>
    </html>
  );
}
