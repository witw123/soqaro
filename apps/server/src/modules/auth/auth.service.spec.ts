import { AuthService } from "./auth.service";

function createPrismaMock() {
  return {
    isAvailable: jest.fn(() => false),
    ensureAvailable: jest.fn(async () => false),
    guestSessions: {
      upsert: jest.fn(),
      findUnique: jest.fn()
    }
  };
}

describe("AuthService", () => {
  afterEach(() => {
    delete process.env.AUTH_FAKE_PERSISTENCE;
    delete process.env.AUTH_FAKE_PERSIST_PATH;
    delete process.env.NODE_ENV;
  });

  it("creates a real random token instead of the placeholder value", async () => {
    const prisma = createPrismaMock();
    const service = new AuthService(prisma as never, {} as never);

    const session = await service.createGuestSession("Host");

    expect(session.token).not.toBe("replace-with-jwt");
    expect(session.token.length).toBeGreaterThan(20);
  });

  it("accepts the matching session token", async () => {
    const prisma = createPrismaMock();
    const service = new AuthService(prisma as never, {} as never);

    const session = await service.createGuestSession("Host");

    await expect(service.assertSessionToken(session.id, session.token)).resolves.toEqual(session);
  });

  it("rejects a missing or invalid session token", async () => {
    const prisma = createPrismaMock();
    const service = new AuthService(prisma as never, {} as never);

    const session = await service.createGuestSession("Host");

    await expect(service.assertSessionToken(session.id)).rejects.toThrow("Invalid session token.");
    await expect(service.assertSessionToken(session.id, "bad-token")).rejects.toThrow(
      "Invalid session token."
    );
  });

  it("requires a non-empty nickname to create a guest session", async () => {
    const prisma = createPrismaMock();
    const service = new AuthService(prisma as never, {} as never);

    await expect(service.createGuestSession("   ")).rejects.toThrow("Nickname is required.");
  });

  it("disables fallback account persistence by default in production", async () => {
    process.env.NODE_ENV = "production";

    const prisma = createPrismaMock();
    const service = new AuthService(prisma as never, {} as never);

    await expect(service.createGuestSession("Host")).rejects.toThrow(
      "Account storage is temporarily unavailable. Please try again after the database is ready."
    );
  });

  it("disables fallback account persistence by default in non-local staging env", async () => {
    process.env.NODE_ENV = "staging";

    const prisma = createPrismaMock();
    const service = new AuthService(prisma as never, {} as never);

    await expect(service.createGuestSession("Host")).rejects.toThrow(
      "Account storage is temporarily unavailable. Please try again after the database is ready."
    );
  });

  it("does not retain plaintext tokens in sessionsByTokenHash and handles logout + pubsub-down revalidation", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    let persistedSessionRow: Record<string, unknown> | null = null;
    const prisma = {
      isAvailable: jest.fn(() => true),
      ensureAvailable: jest.fn(async () => true),
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn()
      },
      userSession: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          persistedSessionRow = data;
          return data;
        }),
        findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
          if (persistedSessionRow && persistedSessionRow.tokenHash === where.tokenHash) {
            return {
              ...persistedSessionRow,
              user: {
                id: "user_1",
                username: "alice",
                nickname: "Alice",
                role: "USER",
                status: "ACTIVE",
                disabledAt: null,
                disabledReason: null,
                lastLoginAt: null,
                passwordHash: "hash",
                createdAt: new Date(),
                updatedAt: new Date()
              }
            };
          }
          return null;
        }),
        deleteMany
      }
    };
    const redis = {
      isAvailable: jest.fn(() => true),
      isPubSubAvailable: jest.fn(() => false),
      publish: jest.fn().mockResolvedValue(undefined)
    };
    const service = new AuthService(prisma as never, redis as never);

    // Register a database user and verify cached session omits plaintext token
    const registered = await service.register({
      username: "alice",
      password: "password123",
      nickname: "Alice"
    });
    const internalSessions = (service as unknown as { sessionsByTokenHash: Map<string, Record<string, unknown>> })
      .sessionsByTokenHash;
    for (const stored of internalSessions.values()) {
      expect(stored.token).toBeUndefined();
      expect(typeof stored.tokenHash).toBe("string");
    }

    // With pubsub unavailable, getAuthSessionByTokenOrThrow revalidates against DB;
    // deleting the DB row causes rejection immediately.
    persistedSessionRow = null;
    await expect(service.getAuthSessionByTokenOrThrow(registered.token)).rejects.toThrow(
      "Invalid session token."
    );

    // Logout deletes DB session by tokenHash and publishes tokenHash invalidation even when not cached
    redis.isPubSubAvailable.mockReturnValue(true);
    await service.logout(registered.token);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.any(String) }
    });
    expect(redis.publish).toHaveBeenCalledWith(
      "soqaro:auth:user-invalidated",
      expect.objectContaining({ tokenHash: expect.any(String) })
    );
  });

  it("evicts cached database users on invalidateSessionsForUser and refreshes mutable fields from DB", async () => {
    let dbPasswordHash = "";
    const prisma = {
      isAvailable: jest.fn(() => true),
      ensureAvailable: jest.fn(async () => true),
      user: {
        findUnique: jest.fn(async () => ({
          id: "user_db_1",
          username: "bob",
          nickname: "Bob",
          role: "USER",
          status: "ACTIVE",
          disabledAt: null,
          disabledReason: null,
          lastLoginAt: null,
          passwordHash: dbPasswordHash,
          createdAt: new Date(),
          updatedAt: new Date()
        })),
        create: jest.fn(),
        update: jest.fn()
      },
      userSession: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new AuthService(prisma as never, {} as never);
    dbPasswordHash = await service.hashPassword("initial-password");

    await expect(service.login({ username: "bob", password: "initial-password" })).resolves.toBeDefined();

    // Admin resets password in DB and invalidates sessions on this instance
    dbPasswordHash = await service.hashPassword("rotated-password");
    await service.invalidateSessionsForUser("user_db_1");

    await expect(service.login({ username: "bob", password: "initial-password" })).rejects.toThrow(
      "Invalid username or password."
    );
    await expect(service.login({ username: "bob", password: "rotated-password" })).resolves.toBeDefined();
  });
});
