import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Put,
  UnauthorizedException
} from "@nestjs/common";
import { z } from "zod";
import {
  providerAlbumSummarySchema,
  providerArtistSummarySchema,
  providerSchema,
  providerTrackCandidateSchema
} from "@soqaro/shared";
import { parseRequestBody } from "../../common/validation/zod-validation";
import { AuthService } from "../auth/auth.service";
import { FavoritesService } from "./favorites.service";

const providerAlbumParamSchema = z.object({
  provider: providerSchema,
  providerAlbumId: z.string().trim().min(1).max(128)
});
const providerTrackParamSchema = z.object({
  provider: providerSchema,
  providerTrackId: z.string().trim().min(1).max(128)
});
const providerArtistParamSchema = z.object({
  provider: providerSchema,
  providerArtistId: z.string().trim().min(1).max(128)
});

@Controller("v1/favorites")
export class FavoritesController {
  constructor(
    private readonly favorites: FavoritesService,
    private readonly auth: AuthService
  ) {}

  @Get("albums")
  async listAlbums(@Headers("x-session-token") sessionToken?: string) {
    return this.favorites.listAlbums(await this.getCurrentUserId(sessionToken));
  }

  @Put("albums")
  async saveAlbum(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const album = parseRequestBody(providerAlbumSummarySchema, body);
    return this.favorites.saveAlbum(await this.getCurrentUserId(sessionToken), album);
  }

  @Delete("albums/:provider/:providerAlbumId")
  async removeAlbum(
    @Param() params: Record<string, unknown>,
    @Headers("x-session-token") sessionToken?: string
  ) {
    const parsed = parseRequestBody(providerAlbumParamSchema, params);
    return this.favorites.removeAlbum(
      await this.getCurrentUserId(sessionToken),
      parsed.provider,
      parsed.providerAlbumId
    );
  }

  @Get("tracks")
  async listTracks(@Headers("x-session-token") sessionToken?: string) {
    return this.favorites.listTracks(await this.getCurrentUserId(sessionToken));
  }

  @Put("tracks")
  async saveTrack(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const track = parseRequestBody(providerTrackCandidateSchema, body);
    return this.favorites.saveTrack(await this.getCurrentUserId(sessionToken), track);
  }

  @Delete("tracks/:provider/:providerTrackId")
  async removeTrack(
    @Param() params: Record<string, unknown>,
    @Headers("x-session-token") sessionToken?: string
  ) {
    const parsed = parseRequestBody(providerTrackParamSchema, params);
    return this.favorites.removeTrack(
      await this.getCurrentUserId(sessionToken),
      parsed.provider,
      parsed.providerTrackId
    );
  }

  @Get("artists")
  async listArtists(@Headers("x-session-token") sessionToken?: string) {
    return this.favorites.listArtists(await this.getCurrentUserId(sessionToken));
  }

  @Put("artists")
  async saveArtist(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const artist = parseRequestBody(providerArtistSummarySchema, body);
    return this.favorites.saveArtist(await this.getCurrentUserId(sessionToken), artist);
  }

  @Delete("artists/:provider/:providerArtistId")
  async removeArtist(
    @Param() params: Record<string, unknown>,
    @Headers("x-session-token") sessionToken?: string
  ) {
    const parsed = parseRequestBody(providerArtistParamSchema, params);
    return this.favorites.removeArtist(
      await this.getCurrentUserId(sessionToken),
      parsed.provider,
      parsed.providerArtistId
    );
  }

  private async getCurrentUserId(sessionToken?: string) {
    try {
      return (await this.auth.getAuthSessionByTokenOrThrow(sessionToken)).userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }
}
