"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft, Eye, EyeOff, X } from "lucide-react";
import { loginRequestSchema, registerRequestSchema } from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { buildAppEntryHref } from "@/lib/domain/client-shell";
import { resolveSafeRedirectPath } from "@/lib/domain/url-safety";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { toUserFacingError } from "@/lib/domain/soqaro-ui";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          action: string;
          theme: "dark";
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
        }
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

type AuthMode = "login" | "register";

function getAuthFormatError(
  mode: AuthMode,
  input: { username: string; password: string; nickname?: string }
) {
  const result = mode === "login"
    ? loginRequestSchema.safeParse({ username: input.username, password: input.password })
    : registerRequestSchema.safeParse({
        username: input.username,
        password: input.password,
        nickname: input.nickname
      });

  if (result.success) return null;

  const field = result.error.issues[0]?.path[0];
  if (field === "username") {
    return "账号格式不对，请输入 1-64 位英文字母、数字、下划线、点或短横线。";
  }
  if (field === "password") {
    return mode === "register"
      ? "密码格式不对，请输入 8-256 位密码。"
      : "密码格式不对，请输入不超过 256 位的密码。";
  }
  if (field === "nickname") {
    return "昵称格式不对，请输入 1-80 个字符。";
  }
  return "账号信息格式不对，请检查后重试。";
}

export function AuthPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = resolveSafeRedirectPath(
    searchParams.get("redirectTo"),
    buildAppEntryHref()
  );
  const [mode, setMode] = useState<AuthMode>("login");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [registerUsername, setRegisterUsername] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [registerNickname, setRegisterNickname] = useState("");
  const [authConfig, setAuthConfig] = useState<{ enabled: boolean; siteKey: string } | null>(null);
  const [authConfigError, setAuthConfigError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [isPending, startTransition] = useTransition();
  const {
    activeSession,
    hydrated,
    statusMessage,
    setStatusMessage,
    setActiveSession
  } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });

  useEffect(() => {
    let cancelled = false;
    void soqaroApi
      .getAuthConfig()
      .then((config) => {
        if (cancelled) return;
        setAuthConfig(config);
        setAuthConfigError("");
      })
      .catch(() => {
        if (cancelled) return;
        setAuthConfigError("安全验证配置加载失败，请刷新页面后重试。");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !activeSession) {
      return;
    }

    router.replace(redirectTo as Route);
  }, [activeSession, hydrated, redirectTo, router]);

  async function handleLogin() {
    if (!loginUsername.trim() || !loginPassword) {
      setStatusMessage("请输入账号和密码。");
      return;
    }

    const formatError = getAuthFormatError("login", {
      username: loginUsername,
      password: loginPassword
    });
    if (formatError) {
      setStatusMessage(formatError);
      return;
    }

    if (!canSubmitAuth()) {
      return;
    }

    try {
      const session = await soqaroApi.login(
        loginUsername.trim(),
        loginPassword,
        turnstileToken ?? undefined
      );
      setActiveSession(session);
      setStatusMessage(`欢迎回来，${session.nickname}。`);
      router.replace(redirectTo as Route);
    } catch (error) {
      setStatusMessage(toUserFacingError(error));
      resetTurnstile();
    }
  }

  async function handleRegister() {
    if (!registerUsername.trim() || !registerPassword || !registerNickname.trim()) {
      setStatusMessage("请完整填写账号、密码和昵称。");
      return;
    }

    const formatError = getAuthFormatError("register", {
      username: registerUsername,
      password: registerPassword,
      nickname: registerNickname
    });
    if (formatError) {
      setStatusMessage(formatError);
      return;
    }

    if (!canSubmitAuth()) {
      return;
    }

    try {
      const session = await soqaroApi.register(
        registerUsername.trim(),
        registerPassword,
        registerNickname.trim(),
        turnstileToken ?? undefined
      );
      setActiveSession(session);
      setStatusMessage(`账号已创建，欢迎你，${session.nickname}。`);
      router.replace(redirectTo as Route);
    } catch (error) {
      setStatusMessage(toUserFacingError(error));
      resetTurnstile();
    }
  }

  function resetTurnstile() {
    setTurnstileToken(null);
    setTurnstileResetKey((value) => value + 1);
  }

  function canSubmitAuth() {
    if (authConfigError) {
      setStatusMessage(authConfigError);
      return false;
    }
    if (!authConfig) {
      setStatusMessage("正在加载安全验证，请稍候。");
      return false;
    }
    if (authConfig.enabled && !turnstileToken) {
      setStatusMessage("请完成人机验证后再继续。");
      return false;
    }
    return true;
  }

  const authUnavailable = !authConfig || !!authConfigError;
  const authSubmitDisabled = authUnavailable || (authConfig?.enabled === true && !turnstileToken);
  const turnstileEnabled = authConfig?.enabled === true && !!authConfig.siteKey;
  const handleTurnstileError = useCallback(() => {
    setTurnstileToken(null);
    setStatusMessage("安全验证加载失败，请刷新页面后重试。");
  }, [setStatusMessage]);

  const statusToneClass =
    statusMessage.includes("失败") || statusMessage.includes("错误")
      ? "text-red-400"
      : "text-accent";

  return (
    <main className="relative flex min-h-[calc(100*var(--app-dvh))] flex-col items-center justify-center bg-background px-4 py-8 font-sans">
      <div className="w-full max-w-sm rounded-xl border border-surface-border bg-surface p-6 sm:p-8 shadow-xs">
        {/* Top bar with back button & badge */}
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface px-2.5 py-1.5 text-xs text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>返回</span>
          </Link>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="text-xs font-semibold text-foreground-muted">Soqaro</span>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            {mode === "login" ? "登录音乐房" : "创建账号"}
          </h1>
          <p className={`mt-1.5 text-xs ${statusMessage ? statusToneClass : "text-foreground-muted"}`}>
            {statusMessage || (mode === "login" ? "输入账号信息后继续进入房间。" : "创建账号后立即进入音乐房。")}
          </p>
        </div>

        {mode === "login" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!authSubmitDisabled && !isPending && loginUsername.trim() && loginPassword) {
                startTransition(() => void handleLogin());
              }
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">账号</span>
              <div className="relative flex items-center">
                <input
                  data-testid="auth-login-username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  spellCheck="false"
                  className="w-full rounded-lg border border-surface-border bg-background pl-3.5 pr-10 py-2.5 text-sm text-foreground shadow-2xs outline-none transition-colors placeholder:text-foreground-muted/50 focus:border-accent focus:ring-1 focus:ring-accent"
                  value={loginUsername}
                  onChange={(event) => setLoginUsername(event.target.value)}
                  placeholder="输入账号"
                />
                {loginUsername ? (
                  <button
                    type="button"
                    onClick={() => setLoginUsername("")}
                    className="absolute right-3 p-1 text-foreground-muted transition-colors hover:text-foreground"
                    title="清空"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">密码</span>
              <div className="relative flex items-center">
                <input
                  data-testid="auth-login-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="current-password"
                  spellCheck="false"
                  className="w-full rounded-lg border border-surface-border bg-background pl-3.5 pr-16 py-2.5 text-sm text-foreground shadow-2xs outline-none transition-colors placeholder:text-foreground-muted/50 focus:border-accent focus:ring-1 focus:ring-accent"
                  type={showLoginPassword ? "text" : "password"}
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  placeholder="输入密码"
                />
                <div className="absolute right-2 flex items-center gap-1">
                  {loginPassword ? (
                    <button
                      type="button"
                      onClick={() => setLoginPassword("")}
                      className="p-1 text-foreground-muted transition-colors hover:text-foreground"
                      title="清空"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword((v) => !v)}
                    className="p-1 text-foreground-muted transition-colors hover:text-foreground"
                    title={showLoginPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showLoginPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </label>

            {turnstileEnabled ? (
              <TurnstileWidget
                key={turnstileResetKey}
                siteKey={authConfig?.siteKey ?? ""}
                onToken={setTurnstileToken}
                onError={handleTurnstileError}
              />
            ) : null}

            <Button
              data-testid="auth-login-submit"
              size="lg"
              className="mt-1 h-10 w-full rounded-lg bg-accent text-sm font-semibold text-white transition-all hover:bg-accent-hover active:scale-[0.99]"
              disabled={
                !loginUsername.trim() ||
                !loginPassword ||
                authSubmitDisabled ||
                isPending
              }
              type="submit"
            >
              {isPending ? "处理中..." : "登录并进入"}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!authSubmitDisabled && !isPending && registerUsername.trim() && registerPassword && registerNickname.trim()) {
                startTransition(() => void handleRegister());
              }
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">账号</span>
              <div className="relative flex items-center">
                <input
                  data-testid="auth-register-username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  spellCheck="false"
                  className="w-full rounded-lg border border-surface-border bg-background pl-3.5 pr-10 py-2.5 text-sm text-foreground shadow-2xs outline-none transition-colors placeholder:text-foreground-muted/50 focus:border-accent focus:ring-1 focus:ring-accent"
                  value={registerUsername}
                  onChange={(event) => setRegisterUsername(event.target.value)}
                  placeholder="设置登录账号"
                />
                {registerUsername ? (
                  <button
                    type="button"
                    onClick={() => setRegisterUsername("")}
                    className="absolute right-3 p-1 text-foreground-muted transition-colors hover:text-foreground"
                    title="清空"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">密码</span>
              <div className="relative flex items-center">
                <input
                  data-testid="auth-register-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="new-password"
                  spellCheck="false"
                  className="w-full rounded-lg border border-surface-border bg-background pl-3.5 pr-16 py-2.5 text-sm text-foreground shadow-2xs outline-none transition-colors placeholder:text-foreground-muted/50 focus:border-accent focus:ring-1 focus:ring-accent"
                  type={showRegisterPassword ? "text" : "password"}
                  value={registerPassword}
                  onChange={(event) => setRegisterPassword(event.target.value)}
                  placeholder="至少 8 位密码"
                />
                <div className="absolute right-2 flex items-center gap-1">
                  {registerPassword ? (
                    <button
                      type="button"
                      onClick={() => setRegisterPassword("")}
                      className="p-1 text-foreground-muted transition-colors hover:text-foreground"
                      title="清空"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setShowRegisterPassword((v) => !v)}
                    className="p-1 text-foreground-muted transition-colors hover:text-foreground"
                    title={showRegisterPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showRegisterPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">昵称</span>
              <div className="relative flex items-center">
                <input
                  data-testid="auth-register-nickname"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  className="w-full rounded-lg border border-surface-border bg-background pl-3.5 pr-10 py-2.5 text-sm text-foreground shadow-2xs outline-none transition-colors placeholder:text-foreground-muted/50 focus:border-accent focus:ring-1 focus:ring-accent"
                  value={registerNickname}
                  onChange={(event) => setRegisterNickname(event.target.value)}
                  placeholder="房间内显示的名字"
                />
                {registerNickname ? (
                  <button
                    type="button"
                    onClick={() => setRegisterNickname("")}
                    className="absolute right-3 p-1 text-foreground-muted transition-colors hover:text-foreground"
                    title="清空"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </label>

            {turnstileEnabled ? (
              <TurnstileWidget
                key={turnstileResetKey}
                siteKey={authConfig?.siteKey ?? ""}
                onToken={setTurnstileToken}
                onError={handleTurnstileError}
              />
            ) : null}

            <Button
              data-testid="auth-register-submit"
              size="lg"
              className="mt-1 h-10 w-full rounded-lg bg-accent text-sm font-semibold text-white transition-all hover:bg-accent-hover active:scale-[0.99]"
              disabled={
                !registerUsername.trim() ||
                !registerPassword ||
                !registerNickname.trim() ||
                authSubmitDisabled ||
                isPending
              }
              type="submit"
            >
              {isPending ? "处理中..." : "注册并进入"}
            </Button>
          </form>
        )}

        <div className="mt-6 border-t border-surface-border pt-4 text-center">
          <p className="text-xs text-foreground-muted">
            {mode === "login" ? "还没有账号？" : "已有账号？"}
            <button
              data-testid="auth-mode-toggle"
              className="ml-2 font-medium text-foreground transition-colors hover:text-accent cursor-pointer"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                resetTurnstile();
                setStatusMessage("");
              }}
              type="button"
            >
              {mode === "login" ? "去注册" : "去登录"}
            </button>
          </p>
        </div>
      </div>
    </main>
  );
}

function TurnstileWidget({
  siteKey,
  onToken,
  onError
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  const [scriptReady, setScriptReady] = useState(false);

  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!scriptReady || !containerRef.current || !window.turnstile) {
      return;
    }

    try {
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: "auth",
        theme: "dark",
        callback: (token) => onTokenRef.current(token),
        "expired-callback": () => onTokenRef.current(null),
        "error-callback": () => onErrorRef.current()
      });
    } catch {
      onError();
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [onError, scriptReady, siteKey]);

  return (
    <div className="min-h-[65px] overflow-hidden" data-testid="auth-turnstile">
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
      />
      <div ref={containerRef} />
    </div>
  );
}
