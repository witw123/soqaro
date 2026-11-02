import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AdminGuard } from "./admin.guard";
import { AdminService, adminCsrfCookie, adminSessionCookie, type AdminPrincipal } from "./admin.service";

@Controller("v1/admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post("auth/login")
  async login(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    const result = await this.admin.login(body, request);
    const secure = process.env.NODE_ENV === "production";
    response.cookie(adminSessionCookie, result.sessionToken, { httpOnly: true, sameSite: "strict", secure, maxAge: 8 * 60 * 60 * 1000, path: "/" });
    response.cookie(adminCsrfCookie, result.csrfToken, { httpOnly: false, sameSite: "strict", secure, maxAge: 8 * 60 * 60 * 1000, path: "/" });
    return { ...result.principal, csrfToken: result.csrfToken };
  }

  @UseGuards(AdminGuard)
  @Post("auth/logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    await this.admin.logout(request); response.clearCookie(adminSessionCookie, { path: "/" }); response.clearCookie(adminCsrfCookie, { path: "/" }); return { ok: true };
  }

  @UseGuards(AdminGuard)
  @Get("session")
  session(@Req() request: Request & { admin?: AdminPrincipal }) { const admin = request.admin!; return { userId: admin.userId, username: admin.username, nickname: admin.nickname, role: admin.role, expiresAt: admin.expiresAt.toISOString(), csrfToken: admin.csrfToken }; }

  @UseGuards(AdminGuard)
  @Get("overview") overview() { return this.admin.overview(); }
  @UseGuards(AdminGuard)
  @Get("rooms") rooms(@Query() query: { q?: string; limit?: string }) { return this.admin.listRooms({ q: query.q, limit: Number(query.limit) || 50 }); }
  @UseGuards(AdminGuard)
  @Get("rooms/:roomId") room(@Param("roomId") roomId: string) { return this.admin.roomDetail(roomId); }
  @UseGuards(AdminGuard)
  @Post("rooms/:roomId/terminate") terminate(@Param("roomId") roomId: string, @Body() body: { reason: string; expectedJoinCode: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.terminateRoom(request.admin!, roomId, body, request); }
  @UseGuards(AdminGuard)
  @Post("rooms/:roomId/playback") controlPlayback(@Param("roomId") roomId: string, @Body() body: { action: "pause" | "play" | "next" | "clear-queue"; reason?: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.controlRoomPlayback(request.admin!, roomId, body.action, body.reason ?? null, request); }
  @UseGuards(AdminGuard)
  @Delete("rooms/:roomId/members/:memberId") kickMember(@Param("roomId") roomId: string, @Param("memberId") memberId: string, @Body() body: { reason?: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.kickRoomMember(request.admin!, roomId, memberId, body?.reason ?? null, request); }
  @UseGuards(AdminGuard)
  @Get("rooms/:roomId/chat") listChat(@Param("roomId") roomId: string, @Query("limit") limit?: string) { return this.admin.listRoomChat(roomId, Number(limit) || 50); }
  @UseGuards(AdminGuard)
  @Delete("rooms/:roomId/chat/:messageId") deleteChat(@Param("roomId") roomId: string, @Param("messageId") messageId: string, @Body() body: { reason?: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.deleteRoomChatMessage(request.admin!, roomId, messageId, body?.reason ?? null, request); }
  @UseGuards(AdminGuard)
  @Get("users") users(@Query() query: { q?: string; limit?: string }) { return this.admin.listUsers({ q: query.q, limit: Number(query.limit) || 50 }); }
  @UseGuards(AdminGuard)
  @Get("users/:userId") user(@Param("userId") userId: string) { return this.admin.userDetail(userId); }
  @UseGuards(AdminGuard)
  @Patch("users/:userId/status") status(@Param("userId") userId: string, @Body() body: unknown, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.setUserStatus(request.admin!, userId, body, request); }
  @UseGuards(AdminGuard)
  @Patch("users/:userId/role") setRole(@Param("userId") userId: string, @Body() body: { role: "ADMIN" | "USER"; reason: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.setUserRole(request.admin!, userId, body.role, body.reason, request); }
  @UseGuards(AdminGuard)
  @Post("users/:userId/reset-password") resetPassword(@Param("userId") userId: string, @Body() body: { newPassword?: string; reason: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.resetUserPassword(request.admin!, userId, body.newPassword, body.reason, request); }
  @UseGuards(AdminGuard)
  @Post("users/:userId/sessions/revoke") revoke(@Param("userId") userId: string, @Body() body: { reason: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.revokeUserSessions(request.admin!, userId, body.reason, request); }
  @UseGuards(AdminGuard)
  @Get("incidents") incidents(@Query("limit") limit?: string) { return this.admin.listIncidents(Number(limit) || 50); }
  @UseGuards(AdminGuard)
  @Patch("incidents/:id/resolve") resolveIncident(@Param("id") id: string, @Body() body: { reason?: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.resolveIncident(request.admin!, id, body?.reason ?? null, request); }
  @UseGuards(AdminGuard)
  @Post("incidents/resolve-all") resolveAllIncidents(@Body() body: { reason?: string }, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.resolveAllIncidents(request.admin!, body?.reason ?? null, request); }
  @UseGuards(AdminGuard)
  @Get("audit-logs") audit(@Query("limit") limit?: string) { return this.admin.listAudit(Number(limit) || 50); }
  @UseGuards(AdminGuard)
  @Get("system") system() { return this.admin.overview(); }
  @UseGuards(AdminGuard)
  @Get("system/providers") systemProviders() { return this.admin.checkProvidersHealth(); }
  @UseGuards(AdminGuard)
  @Get("stats/tracks")
  trackStats() { return this.admin.getTrackStats(); }

  @UseGuards(AdminGuard)
  @Post("system/maintenance")
  runMaintenance(@Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.runSystemMaintenance(request.admin!, request); }

  @UseGuards(AdminGuard)
  @Get("announcements") announcements() { return this.admin.listAnnouncements(); }
  @UseGuards(AdminGuard)
  @Post("announcements") createAnnouncement(@Body() body: unknown, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.createAnnouncement(request.admin!, body, request); }
  @UseGuards(AdminGuard)
  @Patch("announcements/:id") updateAnnouncement(@Param("id") id: string, @Body() body: unknown, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.updateAnnouncement(request.admin!, id, body, request); }
  @UseGuards(AdminGuard)
  @Delete("announcements/:id") deleteAnnouncement(@Param("id") id: string, @Req() request: Request & { admin?: AdminPrincipal }) { return this.admin.deleteAnnouncement(request.admin!, id, request); }
}

