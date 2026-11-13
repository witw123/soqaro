import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { AlistController } from "./alist.controller";
import { AlistService } from "./alist.service";

@Module({
  imports: [AuthModule],
  controllers: [AlistController],
  providers: [AlistService],
  exports: [AlistService]
})
export class AlistModule {}
