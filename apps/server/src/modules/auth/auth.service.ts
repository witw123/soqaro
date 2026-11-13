import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AuthSession, UserProfile } from "@soqaro/shared";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { RedisService } from "../../infra/redis/redis.service";

type PersistenceMode = "database" | "fallback";

type StoredUser = UserProfile & {
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "DISABLED";
  disabledAt?: string | null;
  disabledReason?: string | null;
  lastLoginAt?: string | null;
  persistence: PersistenceMode;
};

type StoredUserSession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  persistence: PersistenceMode;
  validatedAt?: number;
};

type FallbackAuthStore = {
  users: Array<
    Omit<StoredUser, "persistence">
  >;
  sessions: Array<
    Omit<StoredUserSession, "persistence" | "validatedAt">
  >;
};

const sessionTtlMs = 1000 * 60 * 60 * 24 * 14;
const sessionCleanupIntervalMs = 60 * 60 * 1000;
const sessionCacheRevalidateMs = 60 * 1000;
const userInvalidatedChannel = "soqaro:auth:user-invalidated";
const MAX_CACHED_USERS = 20_000;
const MAX_CACHED_SESSIONS = 50_000;
// libuv 线程池执行的异步 scrypt;同步版会在登录突发时阻塞事件循环并卡住
// 同进程的 WS 信令与房间操作。
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

// A valid scrypt hash of an unpublishable random value. Verifying against it
// for unknown usernames keeps the login path's timing indistinguishable from
// the known-user path, closing the response-time username oracle.
const dummyPasswordHash: Promise<string> = hashPassword(randomBytes(32).toString("hex"));

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly usersById = new Map<string, StoredUser>();
  private readonly userIdByUsername = new Map<string, string>();
  private readonly sessionsByTokenHash = new Map<string, StoredUserSession>();
  private readonly allowFallbackPersistence = resolveAllowFallbackPersistence();
  private readonly fallbackStorePath = resolve(
    process.cwd(),
    process.env.AUTH_FAKE_PERSIST_PATH ?? ".tmp/auth-fallback-store.json"
  );
  private fallbackLoaded = false;
  private sessionCleanupTimer?: NodeJS.Timeout;
  private unsubscribeUserInvalidated?: () => Promise<void> | void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService
  ) {}

  onModuleInit() {
    this.sessionCleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, sessionCleanupIntervalMs);
    void this.cleanupExpiredSessions();
    if (this.redisService?.subscribe) {
      // Admin revokes/disables delete the persisted sessions, but this process
      // also keeps validated tokens in memory. The publish/subscribe fan-out is
      // the only way other instances (and this one, via the Redis server) hear
      // about it in time; without it a revoked token keeps passing
      // getAuthSessionByTokenOrThrow until its 14-day TTL.
      this.redisService
        .subscribe(userInvalidatedChannel, (payload) => {
          const data = payload as { userId?: unknown; tokenHash?: unknown };
          if (typeof data.userId === "string") {
            this.invalidateSessionsForUser(data.userId).catch((error) => {
              this.logger.warn(`Failed to invalidate sessions for user: ${String(error)}`);
            });
          }
          if (typeof data.tokenHash === "string") {
            this.sessionsByTokenHash.delete(data.tokenHash);
          }
        })
        .then((unsubscribe) => {
          this.unsubscribeUserInvalidated = unsubscribe;
        })
        .catch((error) => {
          this.logger.warn(`Auth session invalidation subscription unavailable: ${String(error)}`);
        });
    }
  }

  onModuleDestroy() {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
    }
    void this.unsubscribeUserInvalidated?.();
  }

  hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  /**
   * Drop every in-memory session belonging to the user. Admin revocation calls
   * this directly on the handling instance; other instances are reached through
   * the user-invalidated Redis channel.
   */
  async invalidateSessionsForUser(userId: string) {
    await this.ensureFallbackStoreLoaded();

    let fallbackChanged = false;
    for (const session of [...this.sessionsByTokenHash.values()]) {
      if (session.userId !== userId) continue;
      this.sessionsByTokenHash.delete(session.tokenHash);
      if (session.persistence === "fallback") {
        fallbackChanged = true;
      }
    }

    const cachedUser = this.usersById.get(userId);
    if (cachedUser && cachedUser.persistence === "database") {
      this.evictCachedUser(cachedUser);
    }

    if (fallbackChanged) {
      await this.persistFallbackStore().catch(() => undefined);
    }
  }

  async register(input: {
    username: string;
    password: string;
    nickname: string;
  }): Promise<AuthSession> {
    const username = input.username.trim().toLowerCase();
    const nickname = input.nickname.trim();
    const password = input.password;

    if (!username) {
      throw new Error("Username is required.");
    }

    if (!nickname) {
      throw new Error("Nickname is required.");
    }

    if (password.trim().length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    const persistence = await this.resolvePersistenceModeOrThrow();
    await this.assertUsernameAvailable(username);

    const now = new Date().toISOString();
    const user: StoredUser = {
      id: `user_${randomUUID()}`,
      username,
      nickname,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
      role: "USER",
      status: "ACTIVE",
      persistence
    };

    this.cacheUser(user);

    if (persistence === "database") {
      try {
        await this.prisma.user.create({
          data: {
            id: user.id,
            username: user.username,
            passwordHash: user.passwordHash,
            nickname: user.nickname,
            role: user.role,
            status: user.status,
            disabledAt: user.disabledAt ? new Date(user.disabledAt) : null,
            disabledReason: user.disabledReason ?? null,
            lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : null,
            createdAt: new Date(user.createdAt),
            updatedAt: new Date(user.updatedAt)
          }
        });
      } catch (error) {
        // The pre-check races with concurrent registrations; surface the
        // unique-constraint outcome instead of the raw Prisma message.
        if (isUniqueConstraintError(error)) {
          this.usersById.delete(user.id);
          this.userIdByUsername.delete(user.username);
          throw new Error("Username already exists.");
        }
        throw error;
      }
    } else {
      await this.persistFallbackStore();
      this.logger.warn(
        `Database unavailable; created fallback auth user "${user.username}" at ${this.fallbackStorePath}`
      );
    }

    return this.createSessionForUser(user);
  }

  async createGuestSession(nickname: string): Promise<AuthSession> {
    const slugBase =
      nickname
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "user";

    return this.register({
      username: `${slugBase}-${randomBytes(4).toString("hex")}`,
      password: randomBytes(12).toString("hex"),
      nickname
    });
  }

  async login(input: { username: string; password: string }): Promise<AuthSession> {
    const username = input.username.trim().toLowerCase();
    const password = input.password;

    if (!username || !password) {
      throw new Error("Username and password are required.");
    }

    await this.ensureAuthLookupAvailableOrThrow();
    let user: StoredUser | null = null;
    try {
      user = await this.getUserByUsernameOrThrow(username);
    } catch {
      user = null;
    }
    if (!user) {
      // Unknown username: still run one scrypt verification so the response
      // time and error text match the known-user path exactly.
      await verifyPassword(password, await dummyPasswordHash);
      throw new Error("Invalid username or password.");
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new Error("Invalid username or password.");
    }
    // Disabled state is only revealed after the password check, so the login
    // endpoint cannot be used to probe whether an account exists.
    if (user.status === "DISABLED") {
      throw new Error("Account is disabled.");
    }

    const session = await this.createSessionForUser(user);
    if (user.persistence === "database" && (await this.prisma.ensureAvailable())) {
      await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    }
    return session;
  }

  async authenticateCredentials(input: { username: string; password: string }) {
    const username = input.username.trim().toLowerCase();
    if (!username || !input.password) {
      throw new Error("Username and password are required.");
    }
    await this.ensureAuthLookupAvailableOrThrow();
    let user: StoredUser | null = null;
    try {
      user = await this.getUserByUsernameOrThrow(username);
    } catch {
      user = null;
    }
    if (!user) {
      await verifyPassword(input.password, await dummyPasswordHash);
      throw new Error("Invalid username or password.");
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw new Error("Invalid username or password.");
    }
    return {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role ?? "USER",
      status: user.status ?? "ACTIVE"
    };
  }

  async logout(token?: string) {
    if (!token) {
      return { ok: true };
    }

    await this.ensureFallbackStoreLoaded();

    const tokenHash = hashSessionToken(token);
    const cachedSession = this.sessionsByTokenHash.get(tokenHash);
    this.sessionsByTokenHash.delete(tokenHash);

    if (await this.prisma.ensureAvailable()) {
      await this.prisma.userSession.deleteMany({
        where: { tokenHash }
      });
    }

    if (cachedSession?.persistence === "fallback") {
      await this.persistFallbackStore();
    }

    if (this.redisService?.isPubSubAvailable?.()) {
      await this.redisService
        .publish(userInvalidatedChannel, { tokenHash, at: new Date().toISOString() })
        .catch(() => undefined);
    }

    return { ok: true };
  }

  async getAuthSessionByTokenOrThrow(token?: string): Promise<AuthSession> {
    if (!token) {
      throw new Error("Invalid session token.");
    }

    await this.ensureFallbackStoreLoaded();

    const tokenHash = hashSessionToken(token);
    let storedSession = this.sessionsByTokenHash.get(tokenHash) ?? null;

    if (storedSession && storedSession.persistence === "database") {
      const pubSubAvailable = Boolean(this.redisService?.isPubSubAvailable?.());
      const staleCache = Date.now() - (storedSession.validatedAt ?? 0) > sessionCacheRevalidateMs;
      if ((!pubSubAvailable || staleCache) && (await this.prisma.ensureAvailable())) {
        const persisted = await this.prisma.userSession.findUnique({
          where: { tokenHash }
        });
        if (!persisted) {
          this.sessionsByTokenHash.delete(tokenHash);
          throw new Error("Invalid session token.");
        }
        storedSession.expiresAt = persisted.expiresAt.toISOString();
        storedSession.validatedAt = Date.now();
      }
    }

    if (!storedSession) {
      storedSession = await this.getPersistedSessionByTokenHash(tokenHash);
    }

    if (!storedSession) {
      throw new Error("Invalid session token.");
    }

    if (new Date(storedSession.expiresAt).getTime() <= Date.now()) {
      this.sessionsByTokenHash.delete(storedSession.tokenHash);
      if (storedSession.persistence === "database") {
        if (await this.prisma.ensureAvailable()) {
          await this.prisma.userSession.deleteMany({
            where: { tokenHash: storedSession.tokenHash }
          });
        }
      } else {
        await this.persistFallbackStore();
      }
      throw new Error("Session expired.");
    }

    const user = await this.getUserOrThrow(storedSession.userId);
    if ((user as UserProfile & { status?: string }).status === "DISABLED") {
      throw new Error("Account is disabled.");
    }
    return this.toAuthSession(user, storedSession, token);
  }

  async assertSessionToken(userId: string, token?: string) {
    const session = await this.getAuthSessionByTokenOrThrow(token);

    if (session.userId !== userId) {
      throw new Error("Invalid session token.");
    }

    return session;
  }

  async getUserOrThrow(userId: string): Promise<UserProfile> {
    await this.ensureFallbackStoreLoaded();

    const cached = this.usersById.get(userId);
    if (cached) {
      if (cached.persistence === "database" && (await this.prisma.ensureAvailable())) {
        const persisted = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!persisted) {
          this.evictCachedUser(cached);
          throw new Error(`Unknown user: ${userId}`);
        }
        this.applyPersistedUserFields(cached, persisted);
      }
      return toUserProfile(cached);
    }

    if (await this.prisma.ensureAvailable()) {
      const persisted = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (persisted) {
        const user: StoredUser = {
          id: persisted.id,
          username: persisted.username,
          nickname: persisted.nickname,
          role: persisted.role,
          status: persisted.status,
          disabledAt: persisted.disabledAt?.toISOString() ?? null,
          disabledReason: persisted.disabledReason ?? null,
          lastLoginAt: persisted.lastLoginAt?.toISOString() ?? null,
          passwordHash: persisted.passwordHash,
          createdAt: persisted.createdAt.toISOString(),
          updatedAt: persisted.updatedAt.toISOString(),
          persistence: "database"
        };
        this.cacheUser(user);
        return toUserProfile(user);
      }
    }

    throw new Error(`Unknown user: ${userId}`);
  }

  async getUserByUsernameOrThrow(username: string): Promise<StoredUser> {
    await this.ensureFallbackStoreLoaded();

    const cachedUserId = this.userIdByUsername.get(username);
    if (cachedUserId) {
      const cached = this.usersById.get(cachedUserId);
      if (cached) {
        if (cached.persistence === "database" && (await this.prisma.ensureAvailable())) {
          const persisted = await this.prisma.user.findUnique({ where: { id: cached.id } });
          if (!persisted) {
            this.evictCachedUser(cached);
            throw new Error("Invalid username or password.");
          }
          this.applyPersistedUserFields(cached, persisted);
        }
        return cached;
      }
    }

    if (await this.prisma.ensureAvailable()) {
      const persisted = await this.prisma.user.findUnique({
        where: { username }
      });

      if (persisted) {
        const user: StoredUser = {
          id: persisted.id,
          username: persisted.username,
          nickname: persisted.nickname,
          role: persisted.role,
          status: persisted.status,
          disabledAt: persisted.disabledAt?.toISOString() ?? null,
          disabledReason: persisted.disabledReason ?? null,
          lastLoginAt: persisted.lastLoginAt?.toISOString() ?? null,
          passwordHash: persisted.passwordHash,
          createdAt: persisted.createdAt.toISOString(),
          updatedAt: persisted.updatedAt.toISOString(),
          persistence: "database"
        };
        this.cacheUser(user);
        return user;
      }
    }

    throw new Error("Invalid username or password.");
  }

  private async createSessionForUser(user: StoredUser): Promise<AuthSession> {
    const persistence =
      user.persistence === "database" && (await this.prisma.ensureAvailable())
        ? "database"
        : "fallback";

    if (persistence === "fallback" && !this.allowFallbackPersistence) {
      throw new Error(
        "Account storage is temporarily unavailable. Please try again after the database is ready."
      );
    }

    const token = randomBytes(32).toString("base64url");
    const storedSession: StoredUserSession = {
      id: `session_${randomUUID()}`,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
      persistence,
      validatedAt: Date.now()
    };

    this.cacheSession(storedSession);

    if (persistence === "database") {
      await this.prisma.userSession.create({
        data: {
          id: storedSession.id,
          userId: storedSession.userId,
          tokenHash: storedSession.tokenHash,
          createdAt: new Date(storedSession.createdAt),
          expiresAt: new Date(storedSession.expiresAt)
        }
      });
    } else {
      await this.persistFallbackStore();
    }

    return this.toAuthSession(user, storedSession, token);
  }

  private toAuthSession(user: UserProfile, session: StoredUserSession, token = ""): AuthSession {
    return {
      id: user.id,
      userId: user.id,
      username: user.username,
      nickname: user.nickname,
      token,
      createdAt: session.createdAt
    };
  }

  private async assertUsernameAvailable(username: string) {
    await this.ensureFallbackStoreLoaded();

    if (this.userIdByUsername.has(username)) {
      throw new Error("Username already exists.");
    }

    if (await this.prisma.ensureAvailable()) {
      const existing = await this.prisma.user.findUnique({
        where: { username }
      });

      if (existing) {
        throw new Error("Username already exists.");
      }
    }
  }

  private async getPersistedSessionByTokenHash(tokenHash: string) {
    await this.ensureFallbackStoreLoaded();

    if (await this.prisma.ensureAvailable()) {
      const persisted = await this.prisma.userSession.findUnique({
        where: { tokenHash }
      });

      if (persisted) {
        const session: StoredUserSession = {
          id: persisted.id,
          userId: persisted.userId,
          tokenHash: persisted.tokenHash,
          createdAt: persisted.createdAt.toISOString(),
          expiresAt: persisted.expiresAt.toISOString(),
          persistence: "database",
          validatedAt: Date.now()
        };
        this.cacheSession(session);
        return session;
      }
    }

    return this.sessionsByTokenHash.get(tokenHash) ?? null;
  }

  private async resolvePersistenceModeOrThrow(): Promise<PersistenceMode> {
    if (await this.prisma.ensureAvailable()) {
      return "database";
    }

    if (this.allowFallbackPersistence) {
      await this.ensureFallbackStoreLoaded();
      return "fallback";
    }

    throw new Error(
      "Account storage is temporarily unavailable. Please try again after the database is ready."
    );
  }

  private async ensureAuthLookupAvailableOrThrow() {
    if (await this.prisma.ensureAvailable()) {
      return;
    }

    await this.ensureFallbackStoreLoaded();

    if (this.allowFallbackPersistence) {
      return;
    }

    throw new Error(
      "Account storage is temporarily unavailable. Please try again after the database is ready."
    );
  }

  private cacheUser(user: StoredUser) {
    if (this.usersById.has(user.id)) {
      this.usersById.delete(user.id);
    }
    if (this.userIdByUsername.has(user.username)) {
      this.userIdByUsername.delete(user.username);
    }
    this.usersById.set(user.id, user);
    this.userIdByUsername.set(user.username, user.id);
    while (this.userIdByUsername.size > MAX_CACHED_USERS) {
      const oldestUsername = this.userIdByUsername.keys().next().value;
      if (oldestUsername === undefined) break;
      const oldestUserId = this.userIdByUsername.get(oldestUsername);
      this.userIdByUsername.delete(oldestUsername);
      if (oldestUserId) this.usersById.delete(oldestUserId);
    }
  }

  private evictCachedUser(user: StoredUser) {
    this.usersById.delete(user.id);
    if (this.userIdByUsername.get(user.username) === user.id) {
      this.userIdByUsername.delete(user.username);
    }
  }

  private applyPersistedUserFields(
    cached: StoredUser,
    persisted: {
      passwordHash: string;
      nickname: string;
      role: "USER" | "ADMIN";
      status: "ACTIVE" | "DISABLED";
      disabledAt: Date | null;
      disabledReason: string | null;
      lastLoginAt: Date | null;
      updatedAt: Date;
    }
  ) {
    cached.passwordHash = persisted.passwordHash;
    cached.nickname = persisted.nickname;
    cached.role = persisted.role;
    cached.status = persisted.status;
    cached.disabledAt = persisted.disabledAt?.toISOString() ?? null;
    cached.disabledReason = persisted.disabledReason ?? null;
    cached.lastLoginAt = persisted.lastLoginAt?.toISOString() ?? null;
    cached.updatedAt = persisted.updatedAt.toISOString();
  }

  private cacheSession(session: StoredUserSession) {
    if (this.sessionsByTokenHash.has(session.tokenHash)) {
      this.sessionsByTokenHash.delete(session.tokenHash);
    }
    this.sessionsByTokenHash.set(session.tokenHash, session);
    while (this.sessionsByTokenHash.size > MAX_CACHED_SESSIONS) {
      const oldestHash = this.sessionsByTokenHash.keys().next().value;
      if (oldestHash === undefined) break;
      this.sessionsByTokenHash.delete(oldestHash);
    }
  }

  private async ensureFallbackStoreLoaded() {
    if (!this.allowFallbackPersistence || this.fallbackLoaded) {
      return;
    }

    this.fallbackLoaded = true;

    try {
      const raw = await readFile(this.fallbackStorePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FallbackAuthStore>;

      for (const user of parsed.users ?? []) {
        this.cacheUser({
          ...user,
          persistence: "fallback"
        });
      }

      for (const session of parsed.sessions ?? []) {
        const legacyTokenValue = (session as { token?: unknown }).token;
        const legacyToken = typeof legacyTokenValue === "string" ? legacyTokenValue : undefined;
        const tokenHash = typeof session.tokenHash === "string"
          ? session.tokenHash
          : legacyToken
            ? hashSessionToken(legacyToken)
            : null;
        if (!tokenHash) {
          continue;
        }

        const { token: _legacyToken, ...rest } = session as typeof session & { token?: unknown };
        this.cacheSession({
          ...rest,
          tokenHash,
          persistence: "fallback" as const
        });
      }
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error ? String(error.code) : null;
      if (code !== "ENOENT") {
        this.logger.warn(`Failed to read fallback auth store. ${String(error)}`);
      }
    }
  }

  private async persistFallbackStore() {
    if (!this.allowFallbackPersistence) {
      return;
    }

    await this.ensureFallbackStoreLoaded();

    const payload: FallbackAuthStore = {
      users: Array.from(this.usersById.values())
        .filter((user) => user.persistence === "fallback")
        .map(({ persistence: _persistence, ...user }) => user),
      sessions: Array.from(this.sessionsByTokenHash.values())
        .filter((session) => session.persistence === "fallback")
        .filter((session, index, sessions) => sessions.findIndex((item) => item.id === session.id) === index)
        .map(({ persistence: _persistence, validatedAt: _validatedAt, ...session }) => session)
    };

    await mkdir(dirname(this.fallbackStorePath), { recursive: true });
    await writeFile(this.fallbackStorePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async cleanupExpiredSessions() {
    await this.ensureFallbackStoreLoaded();
    const now = Date.now();
    let fallbackChanged = false;

    for (const session of [...this.sessionsByTokenHash.values()]) {
      if (new Date(session.expiresAt).getTime() > now) continue;
      this.sessionsByTokenHash.delete(session.tokenHash);
      if (session.persistence === "fallback") {
        fallbackChanged = true;
      }
    }

    if (fallbackChanged) {
      await this.persistFallbackStore().catch(() => undefined);
    }
    if (await this.prisma.ensureAvailable()) {
      await this.prisma.userSession.deleteMany({
        where: { expiresAt: { lte: new Date(now) } }
      }).catch(() => undefined);
    }
  }
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function toUserProfile(user: StoredUser): UserProfile {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status
  };
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return `${salt}:${hash}`;
}

async function verifyPassword(password: string, storedHash: string) {
  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) {
    return false;
  }

  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

function resolveAllowFallbackPersistence() {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === "production") {
    return false;
  }

  const configured = process.env.AUTH_FAKE_PERSISTENCE?.trim().toLowerCase();
  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return !nodeEnv || nodeEnv === "development" || nodeEnv === "test";
}
