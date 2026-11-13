import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus } from "@nestjs/common";
import { AdminService } from "./admin.service";

function buildService(prisma: Record<string, unknown>, redis: Record<string, unknown>, presence: Record<string, unknown>) {
  return new AdminService(
    prisma as never,
    redis as never,
    {} as never,
    {} as never,
    presence as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe("AdminService directories", () => {
  it("applies room search in the database before taking the page", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: "room_old-match",
        joinCode: "ABCD12",
        visibility: "public",
        hostId: "user_1",
        members: [],
        playback: { status: "paused" },
        updatedAt: new Date("2026-07-01T00:00:00.000Z")
      }
    ]);
    const service = buildService(
      { roomState: { findMany } },
      { isAvailable: () => false },
      { getPresenceSnapshot: jest.fn().mockResolvedValue(new Map()) }
    );

    const result = await service.listRooms({ q: "old-match", limit: 1 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { id: { contains: "old-match", mode: "insensitive" } },
          { joinCode: { contains: "old-match", mode: "insensitive" } }
        ]
      },
      take: 1
    }));
    expect(result.data.map((room) => room.id)).toEqual(["room_old-match"]);
  });

  it("applies user search in the database before taking the page", async () => {
    const userFindMany = jest.fn().mockResolvedValue([
      {
        id: "user_old-match",
        username: "old-user",
        nickname: "Old Match",
        role: "USER",
        status: "ACTIVE",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        lastLoginAt: null,
        userSessions: []
      }
    ]);
    const service = buildService(
      {
        user: { findMany: userFindMany },
        roomState: { findMany: jest.fn().mockResolvedValue([]) }
      },
      { isAvailable: () => false },
      { getPresenceSnapshot: jest.fn().mockResolvedValue(new Map()) }
    );

    const result = await service.listUsers({ q: "old match", limit: 1 });

    expect(userFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { username: { contains: "old match", mode: "insensitive" } },
          { nickname: { contains: "old match", mode: "insensitive" } }
        ]
      },
      take: 1
    }));
    expect(result.data.map((user) => user.id)).toEqual(["user_old-match"]);
  });

  it("creates, lists, updates, and deletes announcements with audit logging", async () => {
    const mockCreated = {
      id: "anno_test",
      title: "新功能通知",
      content: "测试内容说明",
      isActive: true,
      createdAt: new Date("2026-09-22T10:00:00.000Z"),
      updatedAt: new Date("2026-09-22T10:00:00.000Z")
    };
    const mockAuditCreate = jest.fn().mockResolvedValue({});
    const service = buildService(
      {
        ensureAvailable: jest.fn().mockResolvedValue(true),
        systemAnnouncement: {
          create: jest.fn().mockResolvedValue(mockCreated),
          findMany: jest.fn().mockResolvedValue([mockCreated]),
          findUnique: jest.fn().mockResolvedValue(mockCreated),
          update: jest.fn().mockResolvedValue({ ...mockCreated, title: "更新标题", isActive: false }),
          delete: jest.fn().mockResolvedValue(mockCreated)
        },
        adminAuditLog: {
          create: mockAuditCreate
        }
      },
      { isAvailable: () => false },
      { getPresenceSnapshot: jest.fn().mockResolvedValue(new Map()) }
    );

    const admin = { userId: "admin_1", username: "admin", nickname: "Admin", role: "ADMIN" as const, csrfToken: "csrf123456789012", expiresAt: new Date() };
    const fakeReq = { ip: "127.0.0.1", headers: {} } as never;

    // Create
    const created = await service.createAnnouncement(admin, { title: "新功能通知", content: "测试内容说明" }, fakeReq);
    expect(created.title).toBe("新功能通知");
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "announcement.create" })
    }));

    // List
    const list = await service.listAnnouncements();
    expect(list.data).toHaveLength(1);

    // Update
    const updated = await service.updateAnnouncement(admin, "anno_test", { title: "更新标题", isActive: false }, fakeReq);
    expect(updated.title).toBe("更新标题");
    expect(updated.isActive).toBe(false);

    // Delete
    const deleted = await service.deleteAnnouncement(admin, "anno_test", fakeReq);
    expect(deleted.ok).toBe(true);
  });
});

describe("AdminService security hardening", () => {
  const admin = {
    userId: "admin_1",
    username: "admin",
    nickname: "Admin",
    role: "ADMIN" as const,
    csrfToken: "csrf123456789012",
    expiresAt: new Date(Date.now() + 60_000)
  };
  const fakeReq = { ip: "203.0.113.5", headers: {}, socket: { remoteAddress: "203.0.113.5" } } as never;
  const originalPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
  const originalMutationsEnabled = process.env.ADMIN_MUTATIONS_ENABLED;

  afterEach(() => {
    if (originalPanelEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
    else process.env.ADMIN_PANEL_ENABLED = originalPanelEnabled;
    if (originalMutationsEnabled === undefined) delete process.env.ADMIN_MUTATIONS_ENABLED;
    else process.env.ADMIN_MUTATIONS_ENABLED = originalMutationsEnabled;
    jest.restoreAllMocks();
  });

  it("blocks admin login when ADMIN_PANEL_ENABLED is false", async () => {
    process.env.ADMIN_PANEL_ENABLED = "false";
    const service = buildService({}, { isAvailable: () => false }, {});

    await expect(
      service.login({ username: "admin", password: "password123" }, fakeReq)
    ).rejects.toThrow(ForbiddenException);
  });

  it("rate limits admin login failures without letting valid logins burn quota", async () => {
    const counts = new Map<string, number>();
    const redis = {
      isAvailable: () => true,
      getString: jest.fn(async (key: string) => (counts.has(key) ? String(counts.get(key)) : null)),
      incrementWithTtlMs: jest.fn(async (key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
      delete: jest.fn(async (key: string) => {
        counts.delete(key);
      })
    };
    const auth = {
      authenticateCredentials: jest
        .fn()
        .mockRejectedValueOnce(new Error("bad"))
        .mockRejectedValueOnce(new Error("bad"))
        .mockRejectedValueOnce(new Error("bad"))
        .mockRejectedValueOnce(new Error("bad"))
        .mockRejectedValueOnce(new Error("bad"))
        .mockResolvedValue({
          id: "admin_1",
          username: "admin",
          nickname: "Admin",
          role: "ADMIN",
          status: "ACTIVE"
        })
    };
    const prisma = {
      ensureAvailable: jest.fn().mockResolvedValue(true),
      adminSession: { create: jest.fn().mockResolvedValue({}) },
      user: { update: jest.fn().mockResolvedValue({}) },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) }
    };
    const service = new AdminService(
      prisma as never,
      redis as never,
      auth as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      undefined as never
    );

    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.login({ username: "admin", password: "wrong" }, fakeReq)
      ).rejects.toThrow("用户名或密码错误。");
    }

    await expect(
      service.login({ username: "admin", password: "wrong" }, fakeReq)
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });

    // Clear counts and verify successful login clears/does not increment failure buckets
    counts.clear();
    await expect(
      service.login({ username: "admin", password: "correct-password" }, fakeReq)
    ).resolves.toMatchObject({
      principal: expect.objectContaining({ userId: "admin_1", role: "ADMIN" })
    });
    expect(redis.delete).toHaveBeenCalledTimes(2);
  });

  it("blocks resetUserPassword on peer ADMIN targets and short/whitespace passwords, and uses strong random passwords", async () => {
    const prisma = {
      ensureAvailable: jest.fn().mockResolvedValue(true),
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: "admin_2", role: "ADMIN" })
          .mockResolvedValue({ id: "user_1", role: "USER" }),
        update: jest.fn().mockResolvedValue({})
      },
      userSession: { deleteMany: jest.fn().mockResolvedValue({}) },
      adminSession: { deleteMany: jest.fn().mockResolvedValue({}) },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) }
    };
    const auth = {
      hashPassword: jest.fn().mockResolvedValue("hashed"),
      invalidateSessionsForUser: jest.fn().mockResolvedValue(undefined)
    };
    const service = new AdminService(
      prisma as never,
      { isAvailable: () => false, isPubSubAvailable: () => false } as never,
      auth as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      undefined as never
    );

    await expect(
      service.resetUserPassword(admin, "admin_2", { reason: "audit test" }, fakeReq)
    ).rejects.toThrow(ForbiddenException);

    await expect(
      service.resetUserPassword(
        admin,
        "user_1",
        { newPassword: "   abc   ", reason: "audit test" },
        fakeReq
      )
    ).rejects.toThrow(BadRequestException);

    const generated = await service.resetUserPassword(
      admin,
      "user_1",
      { reason: "audit test" },
      fakeReq
    );
    expect(generated.temporaryPassword.length).toBeGreaterThanOrEqual(20);
  });

  it("validates revokeUserSessions, terminateRoom, and setUserStatus inputs before DB mutations and respects ADMIN_MUTATIONS_ENABLED=false", async () => {
    const userSessionDeleteMany = jest.fn().mockResolvedValue({});
    const prisma = {
      ensureAvailable: jest.fn().mockResolvedValue(true),
      user: { findUnique: jest.fn().mockResolvedValue({ id: "user_1", role: "USER" }) },
      userSession: { deleteMany: userSessionDeleteMany }
    };
    const service = buildService(prisma, { isAvailable: () => false }, {});

    await expect(
      service.revokeUserSessions(admin, "user_1", { reason: "" }, fakeReq)
    ).rejects.toThrow(BadRequestException);
    expect(userSessionDeleteMany).not.toHaveBeenCalled();

    await expect(
      service.terminateRoom(admin, "room_1", { reason: "" }, fakeReq)
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.setUserStatus(admin, "user_1", { status: "UNKNOWN", reason: "x" }, fakeReq)
    ).rejects.toThrow(BadRequestException);

    process.env.ADMIN_MUTATIONS_ENABLED = "false";
    await expect(
      service.createAnnouncement(admin, { title: "t", content: "c" }, fakeReq)
    ).rejects.toThrow(ConflictException);
    await expect(
      service.updateAnnouncement(admin, "a1", { title: "t" }, fakeReq)
    ).rejects.toThrow(ConflictException);
    await expect(service.deleteAnnouncement(admin, "a1", fakeReq)).rejects.toThrow(ConflictException);
    await expect(service.resolveIncident(admin, "i1", {}, fakeReq)).rejects.toThrow(ConflictException);
    await expect(service.resolveAllIncidents(admin, {}, fakeReq)).rejects.toThrow(ConflictException);
  });

  it("ignores failed fire-and-forget lastActiveAt updates in validateRequest", async () => {
    const prisma = {
      ensureAvailable: jest.fn().mockResolvedValue(true),
      adminSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sess_1",
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          lastActiveAt: new Date(Date.now() - 10 * 60_000),
          csrfHash: "ignored",
          user: { id: "admin_1", username: "admin", nickname: "Admin", role: "ADMIN", status: "ACTIVE" }
        }),
        update: jest.fn().mockRejectedValue(new Error("transient DB error"))
      }
    };
    const service = buildService(prisma, { isAvailable: () => false }, {});
    const req = {
      method: "GET",
      headers: { cookie: "soqaro_admin_session=tok123; soqaro_admin_csrf=csrf123" }
    } as never;

    await expect(service.validateRequest(req)).resolves.toMatchObject({ userId: "admin_1" });
    expect(prisma.adminSession.update).toHaveBeenCalledTimes(1);
  });
});
