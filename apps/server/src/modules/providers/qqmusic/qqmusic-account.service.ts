import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { QqMusicAccountStatus } from "@soqaro/shared";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { QqMusicCryptoService } from "./qqmusic-crypto.service";

@Injectable()
export class QqMusicAccountService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: QqMusicCryptoService) {}
  async getStatus(userId: string): Promise<QqMusicAccountStatus> {
    const account = await this.findAccount(userId);
    return { connected: !!account, qqMusicUserId: account?.qqMusicUserId ?? null, nickname: account?.nickname ?? null, avatarUrl: account?.avatarUrl ?? null, lastValidatedAt: account?.lastValidatedAt?.toISOString() ?? null };
  }
  async getCookieOrThrow(userId: string) {
    const account = await this.findAccount(userId);
    if (!account) throw new Error("QQ Music account is required.");
    try { return this.crypto.decrypt(account.encryptedCookie, userId); } catch { throw new Error("QQ Music account credentials are invalid."); }
  }
  async getValidationState(userId: string) {
    const account = await this.findAccount(userId);
    if (!account) throw new Error("QQ Music account is required.");
    let cookie: string;
    try {
      cookie = this.crypto.decrypt(account.encryptedCookie, userId);
    } catch {
      throw new Error("QQ Music account credentials are invalid.");
    }
    return {
      cookie,
      qqMusicUserId: account.qqMusicUserId,
      lastValidatedAt: account.lastValidatedAt
    };
  }
  async markValidated(userId: string) {
    await this.ensureDatabase();
    await this.prisma.qqMusicAccount.updateMany({ where: { userId }, data: { lastValidatedAt: new Date() } });
  }
  async saveAccount(input: { userId: string; cookie: string; qqMusicUserId: string | null; nickname: string | null; avatarUrl: string | null }) {
    await this.ensureDatabase(); const encryptedCookie = this.crypto.encrypt(input.cookie, input.userId);
    return this.prisma.qqMusicAccount.upsert({ where: { userId: input.userId }, update: { qqMusicUserId: input.qqMusicUserId, nickname: input.nickname, avatarUrl: input.avatarUrl, encryptedCookie, lastValidatedAt: new Date() }, create: { id: `qqmusic_${randomUUID()}`, userId: input.userId, qqMusicUserId: input.qqMusicUserId, nickname: input.nickname, avatarUrl: input.avatarUrl, encryptedCookie, lastValidatedAt: new Date() } });
  }
  async disconnect(userId: string) { await this.ensureDatabase(); await this.prisma.qqMusicAccount.deleteMany({ where: { userId } }); return { ok: true }; }
  async invalidate(userId: string) { await this.ensureDatabase(); await this.prisma.qqMusicAccount.deleteMany({ where: { userId } }); }
  private async findAccount(userId: string) { await this.ensureDatabase(); return this.prisma.qqMusicAccount.findUnique({ where: { userId } }); }
  private async ensureDatabase() { if (!(await this.prisma.ensureAvailable())) throw new Error("Account storage is temporarily unavailable."); }
}
