import { Module } from "@nestjs/common";
import { MetricsModule } from "../../common/metrics/metrics.module";
import { AuthModule } from "../auth/auth.module";
import { RoomCoreModule } from "../room/room-core.module";
import { PlaylistModule } from "../playlist/playlist.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";

@Module({
  imports: [AuthModule, RoomCoreModule, PlaylistModule, MetricsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard]
})
export class AdminModule {}
