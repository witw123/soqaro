import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { NeteaseModule } from "../netease/netease.module";
import { QqMusicModule } from "../qqmusic/qqmusic.module";
import { BilibiliApiClient } from "./bilibili-api.client";
import { BilibiliController } from "./bilibili.controller";
import { BilibiliService } from "./bilibili.service";

@Module({
  imports: [AuthModule, NeteaseModule, QqMusicModule],
  controllers: [BilibiliController],
  providers: [BilibiliApiClient, BilibiliService],
  exports: [BilibiliService, BilibiliApiClient]
})
export class BilibiliModule {}
