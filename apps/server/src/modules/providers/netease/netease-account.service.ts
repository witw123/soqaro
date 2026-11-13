import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NeteaseAccountStatus } from "@soqaro/shared";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { NeteaseCryptoService } from "./netease-crypto.service";

@Injectable()
export class NeteaseAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: NeteaseCryptoService
  ) {}

  async getStatus(userId: string): Promise<NeteaseAccountStatus> {
    const account = await this.findAccount(userId);
    return {
      connected: !!account,
      neteaseUserId: account?.neteaseUserId ?? null,
      nickname: account?.nickname ?? null,
      avatarUrl: account?.avatarUrl ?? null,
      lastValidatedAt: account?.lastValidatedAt?.toISOString() ?? null
    };
  }

  async getCookieOrThrow(userId: string) {
    const account = await this.findAccount(userId);
    if (!account) {
      throw new Error("NetEase account is required.");
    }

    try {
      return this.crypto.decrypt(account.encryptedCookie, userId);
    } catch {
      throw new Error("NetEase account credentials are invalid.");
    }
  }

  async saveAccount(input: {
    userId: string;
    cookie: string;
    neteaseUserId: string | null;
    nickname: string | null;
    avatarUrl: string | null;
  }) {
    await this.ensureDatabase();
    const encryptedCookie = this.crypto.encrypt(input.cookie, input.userId);
    return this.prisma.neteaseAccount.upsert({
      where: { userId: input.userId },
      update: {
        neteaseUserId: input.neteaseUserId,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        encryptedCookie,
        lastValidatedAt: new Date()
      },
      create: {
        id: `netease_${randomUUID()}`,
        userId: input.userId,
        neteaseUserId: input.neteaseUserId,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        encryptedCookie,
        lastValidatedAt: new Date()
      }
    });
  }

  async disconnect(userId: string) {
    await this.ensureDatabase();
    await this.prisma.neteaseAccount.deleteMany({ where: { userId } });
    return { ok: true };
  }

  async invalidate(userId: string) {
    await this.ensureDatabase();
    await this.prisma.neteaseAccount.deleteMany({ where: { userId } });
  }

  private async findAccount(userId: string) {
    await this.ensureDatabase();
    return this.prisma.neteaseAccount.findUnique({ where: { userId } });
  }

  private async ensureDatabase() {
    if (!(await this.prisma.ensureAvailable())) {
      throw new Error("Account storage is temporarily unavailable.");
    }
  }
}
