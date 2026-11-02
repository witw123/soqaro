import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  PersonalizationFeedback,
  PersonalizationProfileResponse,
  PersonalizationRecommendationsQuery,
  PersonalizationRecommendationsResponse,
  PersonalizationTrack,
  PersonalizationTrackInput,
  ProviderPlaylistSummary,
  ProviderTrackCandidate,
  RecordPersonalizationEvent,
  TasteEntityKind
} from "@soqaro/shared";
import { PrismaService } from "../../infra/prisma/prisma.service";
import type { Prisma } from "../../generated/prisma";
import { RedisService } from "../../infra/redis/redis.service";
import { NeteaseService } from "../providers/netease/netease.service";
import { QqMusicService } from "../providers/qqmusic/qqmusic.service";
import { RoomService } from "../room/room.service";
import {
  dedupeCandidates,
  partitionDiscoveryRecommendations,
  rankRecommendationCandidates,
  rerankRecommendationCandidates,
  selectPersonalizedPlaylists,
  trackIdentity,
  type RecommendationCandidate
} from "./recommendation-engine";
import { buildTasteGroups, extractTasteEvidence, inferBehavioralSceneEvidence } from "./taste-taxonomy";

import {
  buildBehaviorTasteTags,
  buildTopArtists,
  entityScore,
  entityToCandidate,
  eventWeight,
  historicalTasteEntities,
  longTermHalfLifeMs,
  normalizeText,
  playlistTasteEntities,
  profileVersion,
  trackKey,
  type TasteEntityRecord,
  type TasteEventRecord
} from "./personalization.helpers";

const recallCacheSeconds = 30 * 60;
const recallEpochSeconds = 30 * 24 * 60 * 60;
const recommendedRememberSeconds = 7 * 24 * 60 * 60;
const maxTracksPerSection = 16;
const compactionCutoffDays = 30;
const compactionTriggerProbability = 0.05;

type Provider = "netease" | "qqmusic";
type Candidate = RecommendationCandidate;

@Injectable()
export class PersonalizationService {
  private readonly recallEpochFallback = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly netease: NeteaseService,
    private readonly qqmusic: QqMusicService,
    private readonly roomService: RoomService
  ) {}

  async recordEvent(userId: string, input: RecordPersonalizationEvent) {
    this.assertDatabaseAvailable();
    await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.userTasteEvent.findUnique({
        where: { userId_clientEventId: { userId, clientEventId: input.id } }
      });
      const weight = eventWeight(input);
      const previousWeight = existing?.weight ?? 0;
      const occurredAt = new Date(input.occurredAt);
      const payload = {
        eventType: input.type,
        surface: input.surface ?? null,
        entityKind: "track",
        entityKey: trackKey(input.track),
        provider: input.track.provider,
        providerItemId: input.track.providerTrackId,
        title: input.track.title,
        artist: input.track.artist,
        album: input.track.album ?? null,
        durationMs: input.track.durationMs,
        listenedMs: BigInt(input.listenedMs ?? 0),
        weight,
        timezoneOffsetMinutes: input.timezoneOffsetMinutes ?? 0,
        occurredAt
      };
      if (existing) {
        await transaction.userTasteEvent.update({ where: { id: existing.id }, data: payload });
      } else {
        await transaction.userTasteEvent.create({
          data: { id: `taste_event_${randomUUID()}`, userId, clientEventId: input.id, ...payload }
        });
      }
      const excluded = await transaction.userRecommendationExclusion.findUnique({
        where: { userId_targetKind_targetKey: { userId, targetKind: "track", targetKey: trackKey(input.track) } }
      });
      if (excluded?.reason === "exclude-from-profile") return;
      const delta = weight - previousWeight;
      if (delta === 0 && existing) return;
      await this.projectTrack(transaction, userId, input.track, delta, occurredAt, !existing, input.timezoneOffsetMinutes ?? 0);
    });
    // Plain playback heartbeats only nudge entity scores by tiny increments;
    // invalidating the recall cache on every one of them kept the cache
    // permanently cold during playback. Substantive events (favorite, skip,
    // manual selection, …) still refresh recommendations immediately.
    if (input.type !== "playback") {
      await this.bumpRecallEpoch(userId);
    }
    // Opportunistic maintenance: merge aged duplicate playback rows so the
    // event table stays proportional to distinct listening history.
    if (Math.random() < compactionTriggerProbability) {
      void this.compactPlaybackEvents(userId).catch(() => undefined);
    }
    return { ok: true };
  }

  async recordFeedback(userId: string, input: PersonalizationFeedback) {
    this.assertDatabaseAvailable();
    await this.prisma.userRecommendationExclusion.upsert({
      where: { userId_targetKind_targetKey: { userId, targetKind: input.target.kind, targetKey: input.target.key } },
      update: { reason: input.action },
      create: {
        id: `taste_exclusion_${randomUUID()}`,
        userId,
        targetKind: input.target.kind,
        targetKey: input.target.key,
        reason: input.action,
        label: input.target.label ?? null
      }
    });
    if (input.action === "exclude-from-profile") {
      await this.prisma.$transaction([
        this.prisma.userTasteEntity.deleteMany({ where: { userId, entityKind: input.target.kind, entityKey: input.target.key } }),
        this.prisma.userTasteEvent.deleteMany({ where: { userId, entityKind: input.target.kind, entityKey: input.target.key } })
      ]);
    }
    await this.bumpRecallEpoch(userId);
    return { ok: true };
  }

  async listExclusions(userId: string) {
    this.assertDatabaseAvailable();
    const items = await this.prisma.userRecommendationExclusion.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return items.map((item) => ({
      kind: item.targetKind as "track" | "artist",
      key: item.targetKey,
      label: item.label,
      action: item.reason as "not-interested" | "exclude-from-profile",
      createdAt: item.createdAt.toISOString()
    }));
  }

  async removeExclusion(userId: string, kind: "track" | "artist", key: string) {
    this.assertDatabaseAvailable();
    await this.prisma.userRecommendationExclusion.deleteMany({ where: { userId, targetKind: kind, targetKey: key } });
    await this.bumpRecallEpoch(userId);
    return { ok: true };
  }

  async getProfile(userId: string): Promise<PersonalizationProfileResponse> {
    this.assertDatabaseAvailable();
    const [entities, events, playlists] = await Promise.all([
      // 画像聚合有界化:按最近排序取上限,防止老用户历史无界增长拖垮查询。
      this.prisma.userTasteEntity.findMany({ where: { userId }, orderBy: { lastOccurredAt: "desc" }, take: 2_000 }),
      this.prisma.userTasteEvent.findMany({ where: { userId }, orderBy: { occurredAt: "desc" }, take: 5_000 }),
      this.prisma.playlist.findMany({ where: { ownerId: userId }, select: { title: true, description: true, tags: true, trackIds: true } })
    ]);
    const playbackEvents = events.filter((event) => event.eventType === "playback");
    const tracks = entities.filter((item) => item.entityKind === "track");
    const artists = entities.filter((item) => item.entityKind === "artist");
    const topArtists = buildTopArtists(playbackEvents, artists);
    const tasteGroups = buildTasteGroups({
      entities: [...entities, ...playlistTasteEntities(tracks, playlists), ...historicalTasteEntities(events)],
      behavior: buildBehaviorTasteTags(events, playbackEvents),
      score: entityScore
    });
    const totalListenedMs = playbackEvents.reduce((total, event) => total + Number(event.listenedMs), 0);
    const trackEntityMap = new Map(tracks.map((item) => [item.entityKey, item]));
    const topTracks = tracks
      .map((item) => ({ item, candidate: entityToCandidate(item) }))
      .filter((value): value is { item: typeof entities[number]; candidate: ProviderTrackCandidate } => value.candidate !== null)
      .sort((left, right) => entityScore(right.item) - entityScore(left.item))
      .slice(0, 20)
      .map(({ item, candidate }) => ({
        ...candidate,
        score: entityScore(item),
        reasons: ["长期偏好"],
        listenedMs: Number(playbackEvents.filter((event) => event.entityKey === item.entityKey).reduce((total, event) => total + event.listenedMs, BigInt(0))),
        playCount: playbackEvents.filter((event) => event.entityKey === item.entityKey).length
      }));

    const seenRecentKeys = new Set<string>();
    const recentTracks: PersonalizationTrack[] = [];
    const sortedPlaybackEvents = [...playbackEvents].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
    for (const event of sortedPlaybackEvents) {
      if (!event.provider || !event.providerItemId) continue;
      const key = `${event.provider}:${event.providerItemId}`;
      if (seenRecentKeys.has(key)) continue;
      seenRecentKeys.add(key);
      const entity = trackEntityMap.get(key) ?? trackEntityMap.get(event.entityKey);
      const candidate = entity ? entityToCandidate(entity) : null;
      const baseCandidate: ProviderTrackCandidate = candidate ?? {
        provider: (event.provider === "qqmusic" ? "qqmusic" : "netease"),
        providerTrackId: event.providerItemId,
        title: event.title ?? "未知曲目",
        artist: event.artist ?? "未知歌手",
        album: event.album ?? null,
        durationMs: event.durationMs,
        artworkUrl: null,
        access: "unknown",
        quality: null
      };
      recentTracks.push({
        ...baseCandidate,
        score: 1,
        reasons: ["最近播放"]
      });
      if (recentTracks.length >= 15) break;
    }

    const sourceDistribution = (["netease", "qqmusic", "bilibili", "alist", "local_upload"] as const).map((source) => ({
      source,
      listenedMs: Number(playbackEvents.filter((event) => event.provider === source).reduce((total, event) => total + event.listenedMs, BigInt(0)))
    })).filter((item) => item.listenedMs > 0);
    const version = profileVersion(entities, events);
    return {
      version,
      startedAt: playbackEvents.map((event) => event.occurredAt).sort((left, right) => left.getTime() - right.getTime())[0]?.toISOString() ?? null,
      totalListenedMs,
      totalPlayCount: playbackEvents.length,
      trackCount: tracks.filter((item) => item.interactionCount > 0).length,
      artistCount: topArtists.length,
      tasteGroups,
      topTracks,
      topArtists: topArtists.slice(0, 20),
      recentTracks,
      sourceDistribution
    };
  }

  async getRecommendations(
    userId: string,
    query: PersonalizationRecommendationsQuery
  ): Promise<PersonalizationRecommendationsResponse> {
    this.assertDatabaseAvailable();
    const [entities, events, exclusions, listenedTracks] = await Promise.all([
      this.prisma.userTasteEntity.findMany({ where: { userId }, orderBy: { lastOccurredAt: "desc" }, take: 2_000 }),
      this.prisma.userTasteEvent.findMany({ where: { userId }, orderBy: { occurredAt: "desc" }, take: 50 }),
      this.prisma.userRecommendationExclusion.findMany({ where: { userId } }),
      query.surface === "discover"
        ? this.prisma.userTasteEvent.findMany({
            where: { userId, eventType: "playback" },
            distinct: ["entityKey"],
            take: 1_000,
            select: { entityKey: true, title: true, artist: true }
          })
        : query.surface === "radio"
          ? this.prisma.userTasteEvent.findMany({
              where: { userId, eventType: "playback" },
              orderBy: { occurredAt: "desc" },
              take: 20,
              select: { entityKey: true, title: true, artist: true }
            })
          : Promise.resolve([])
    ]);
    const providers = await this.getBoundProviders(userId);
    const epoch = await this.getRecallEpoch(userId);
    const cacheKey = `personalization:recall:v4:${userId}:${epoch}:${query.surface}:${query.provider ?? "all"}`;
    const cached = this.redis.isAvailable()
      ? await this.redis.getJson<{ candidates: Candidate[]; playlists: ProviderPlaylistSummary[] }>(cacheKey).catch(() => null)
      : null;
    const recalled: { candidates: Candidate[]; playlists: ProviderPlaylistSummary[] } = cached ?? await this.recallCandidates(userId, entities, events, providers, query.surface, query.provider);
    if (!cached && this.redis.isAvailable()) {
      await this.redis.setJson(cacheKey, recalled, recallCacheSeconds).catch(() => undefined);
    }
    const excludedTracks = new Set([
      ...(query.excludedTrackKeys ?? []),
      ...(query.currentTrackKey ? [query.currentTrackKey] : []),
      ...exclusions.filter((item) => item.targetKind === "track").map((item) => item.targetKey)
    ]);
    const excludedIdentities = new Set(listenedTracks.flatMap((item) => item.title && item.artist ? [trackIdentity({ title: item.title, artist: item.artist })] : []));
    const excludedArtists = new Set(exclusions.filter((item) => item.targetKind === "artist").map((item) => item.targetKey));
    const recentlyRecommendedKeys = this.redis.isAvailable()
      ? new Set(await this.redis.client.smembers(`personalization:recommended:${userId}`).catch(() => []))
      : new Set<string>();
    const ranked = rankRecommendationCandidates({
      candidates: recalled.candidates,
      entities,
      events,
      excludedTracks,
      excludedIdentities,
      excludedArtists,
      recentlyRecommendedKeys,
      surface: query.surface,
      scoreEntity: entityScore
    });
    const discoverSections = query.surface === "discover"
      ? partitionDiscoveryRecommendations(ranked, maxTracksPerSection)
      : null;
    const forYou = discoverSections?.forYou ?? rerankRecommendationCandidates({
      items: ranked.filter((item) => item.source !== "artist"),
      limit: maxTracksPerSection,
      explorationRatio: 0.08
    });
    const familiarArtists = discoverSections?.familiarArtists ?? rerankRecommendationCandidates({
      items: ranked.filter((item) => item.source === "artist" && !new Set(forYou.map(trackKey)).has(trackKey(item.candidate))),
      limit: maxTracksPerSection,
      explorationRatio: 0
    });
    const moodDiscovery = discoverSections?.moodDiscovery ?? [];
    const deepCuts = discoverSections?.deepCuts ?? [];
    const playlists = selectPersonalizedPlaylists({ playlists: recalled.playlists, entities, limit: 10, scoreEntity: entityScore });
    await this.markRecommended(userId, [...forYou, ...familiarArtists, ...moodDiscovery, ...deepCuts]);

    // Build Daily Radar mix
    const dailyRadarTracks = dedupeCandidates(
      [...forYou, ...deepCuts, ...familiarArtists].map((candidate) => ({
        candidate,
        source: "related" as const,
        baseScore: candidate.score,
        interestKey: trackKey(candidate),
        interestLabel: candidate.title
      }))
    ).slice(0, 30).map((c) => ({ ...c.candidate, score: c.baseScore, reasons: ["今日私享雷达精选"] }));

    const genreSet = new Set<string>();
    for (const track of dailyRadarTracks) {
      const evidence = extractTasteEvidence({ title: track.title, artist: track.artist, album: track.album, providerTags: track.tags });
      evidence.filter((e) => e.dimension === "genre").forEach((e) => genreSet.add(e.label));
    }
    const summaryGenres = [...genreSet].slice(0, 4);

    const dailyRadar = query.surface === "discover" && dailyRadarTracks.length > 0 ? {
      date: new Date().toISOString().slice(0, 10),
      title: "Soqaro 每日心动雷达",
      subtitle: `根据你最近的品味定制，已融合 ${summaryGenres.length ? summaryGenres.join("、") : "流行与常听"} 风格`,
      tracks: dailyRadarTracks,
      summaryGenres
    } : undefined;

    // Fetch Live Rooms for collaborative discovery
    let liveRooms: PersonalizationRecommendationsResponse["liveRooms"] = undefined;
    if (query.surface === "discover") {
      const publicRooms = await this.roomService.listPublicRooms().catch(() => []);

      liveRooms = publicRooms.slice(0, 6).map((snapshot) => {
        const hostMember = snapshot.room.members.find((member) => member.id === snapshot.room.hostId);
        const onlineCount = snapshot.room.members.filter(
          (member) => member.presenceState === "online" && !!member.peerId
        ).length;
        const currentTrack = snapshot.room.playback.currentTrackId
          ? snapshot.tracks.find((track) => track.id === snapshot.room.playback.currentTrackId) ?? null
          : null;

        return {
          roomId: snapshot.room.id,
          roomTitle: snapshot.room.name ?? "未命名房间",
          hostName: hostMember?.nickname || "房主",
          mode: snapshot.room.roomType === "radio"
            ? "radio"
            : snapshot.room.roomType === "request"
              ? "request"
              : "common",
          listenerCount: onlineCount,
          currentTrack: currentTrack?.title ? {
            title: currentTrack.title,
            artist: currentTrack.artist,
            artworkUrl: currentTrack.artworkUrl ?? null
          } : null
        };
      });
    }

    return { profileVersion: profileVersion(entities, events), providers, forYou, familiarArtists, moodDiscovery, deepCuts, playlists, dailyRadar, liveRooms };
  }

  async getTrackRadio(
    userId: string,
    query: import("@soqaro/shared").TrackRadioQuery
  ): Promise<import("@soqaro/shared").PersonalizationTrack[]> {
    this.assertDatabaseAvailable();
    const seed = query.seedTrack;
    const providers = await this.getBoundProviders(userId);
    const targetProvider: Provider = (seed.provider === "netease" || seed.provider === "qqmusic")
      ? seed.provider
      : (providers[0] ?? "netease");

    const candidates: Candidate[] = [];
    const service = targetProvider === "netease" ? this.netease : this.qqmusic;

    if (seed.artist) {
      const artistResult = await service.searchTracks(userId, { keywords: seed.artist, limit: 24, offset: 0 }).catch(() => null);
      if (artistResult?.items.length) {
        candidates.push(...artistResult.items.map((candidate) => ({
          candidate,
          source: "artist" as const,
          baseScore: 0.8,
          interestKey: `artist:${normalizeText(seed.artist)}`,
          interestLabel: seed.artist
        })));
      }
    }

    const evidence = extractTasteEvidence({
      title: seed.title,
      artist: seed.artist,
      album: seed.album,
      providerTags: seed.providerTags
    });
    const genreLabels = evidence.filter((e) => e.dimension === "genre" || e.dimension === "scene").map((e) => e.label).slice(0, 2);
    for (const label of genreLabels) {
      const genreResult = await service.searchTracks(userId, { keywords: label, limit: 16, offset: 0 }).catch(() => null);
      if (genreResult?.items.length) {
        candidates.push(...genreResult.items.map((candidate) => ({
          candidate,
          source: "explore" as const,
          baseScore: 0.7,
          interestKey: `taste:${normalizeText(label)}`,
          interestLabel: label
        })));
      }
    }

    if (seed.providerTrackId && (seed.provider === "netease" || seed.provider === "qqmusic")) {
      const related = await service.getRelatedPlaylists(userId, seed.providerTrackId).catch(() => null);
      if (related?.items.length) {
        const details = await Promise.all(related.items.slice(0, 2).map((p) => service.getPlaylist(userId, p.providerPlaylistId).catch(() => null)));
        details.filter((d): d is NonNullable<typeof d> => d !== null).forEach((detail) => {
          candidates.push(...detail.tracks.slice(0, 15).map((candidate) => ({
            candidate,
            source: "related" as const,
            baseScore: 0.75,
            interestKey: `seed:${trackIdentity(seed)}`,
            interestLabel: seed.title
          })));
        });
      }
    }

    const exclusions = await this.prisma.userRecommendationExclusion.findMany({ where: { userId } });
    const excludedKeys = new Set([
      ...(query.excludedTrackKeys ?? []),
      ...exclusions.filter((e) => e.targetKind === "track").map((e) => e.targetKey)
    ]);

    const { buildTrackRadioRecommendations } = await import("./recommendation-engine");
    return buildTrackRadioRecommendations({
      seedTrack: seed,
      candidates,
      excludedTrackKeys: excludedKeys,
      limit: query.limit
    });
  }

  async bootstrapColdStartProfile(
    userId: string,
    input: import("@soqaro/shared").ColdStartTasteInput
  ): Promise<{ ok: boolean }> {
    this.assertDatabaseAvailable();
    const now = new Date();
    // Adjustments replace the previous seed set entirely, so deselecting a
    // category stops influencing recall immediately instead of lingering.
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.userTasteEntity.deleteMany({
        where: { userId, entityKey: { startsWith: "seed:" } }
      })
    ];

    for (const selection of input.selections) {
      ops.push(
        this.prisma.userTasteEntity.upsert({
          where: { userId_entityKind_entityKey: { userId, entityKind: selection.dimension, entityKey: `seed:${normalizeText(selection.label)}` } },
          create: {
            id: randomUUID(),
            userId,
            entityKind: selection.dimension,
            entityKey: `seed:${normalizeText(selection.label)}`,
            title: selection.label,
            positiveScore: 8.0,
            negativeScore: 0,
            confidence: 0.95,
            durationMs: 0,
            updatedAt: now
          },
          update: {
            positiveScore: 8.0,
            negativeScore: 0,
            confidence: 0.95,
            updatedAt: now
          }
        })
      );
    }

    if (input.initialArtists?.length) {
      for (const artist of input.initialArtists) {
        ops.push(
          this.prisma.userTasteEntity.upsert({
            where: { userId_entityKind_entityKey: { userId, entityKind: "artist", entityKey: `seed:artist:${normalizeText(artist)}` } },
            create: {
              id: randomUUID(),
              userId,
              entityKind: "artist",
              entityKey: `seed:artist:${normalizeText(artist)}`,
              title: artist,
              positiveScore: 9.0,
              negativeScore: 0,
              confidence: 0.95,
              durationMs: 0,
              updatedAt: now
            },
            update: {
              positiveScore: 9.0,
              negativeScore: 0,
              confidence: 0.95,
              updatedAt: now
            }
          })
        );
      }
    }

    await this.prisma.$transaction(ops);
    await this.bumpRecallEpoch(userId);
    return { ok: true };
  }

  async clearProfile(userId: string) {
    this.assertDatabaseAvailable();
    await this.prisma.$transaction([
      this.prisma.userTasteEvent.deleteMany({ where: { userId } }),
      this.prisma.userTasteEntity.deleteMany({ where: { userId } }),
      this.prisma.userRecommendationExclusion.deleteMany({ where: { userId } })
    ]);
    await this.bumpRecallEpoch(userId);
    return { ok: true };
  }

  private async getBoundProviders(userId: string): Promise<Provider[]> {
    const accounts = await Promise.all([
      this.prisma.neteaseAccount.findUnique({ where: { userId }, select: { id: true } }),
      this.prisma.qqMusicAccount.findUnique({ where: { userId }, select: { id: true } })
    ]);
    return accounts.flatMap((account, index) => account ? [index === 0 ? "netease" : "qqmusic"] : []);
  }

  private async recallCandidates(userId: string, entities: TasteEntityRecord[], events: TasteEventRecord[], providers: Provider[], surface: PersonalizationRecommendationsQuery["surface"], preferredProvider?: Provider) {
    const orderedProviders = preferredProvider ? providers.filter((provider) => provider === preferredProvider) : providers;
    const recalls = await Promise.all(orderedProviders.map((provider) => this.recallProvider(userId, provider, entities, events, surface)));
    return {
      candidates: recalls.flatMap((item) => item.candidates),
      playlists: recalls.flatMap((item) => item.playlists)
    };
  }

  // `events` and `surface` are the inputs the provider-playlist recall path was
  // meant to consume; that path is currently stubbed (`playlists: []` below), so
  // they are carried through unused rather than dropped from the signature.
  private async recallProvider(userId: string, provider: Provider, entities: TasteEntityRecord[], _events: TasteEventRecord[], _surface: PersonalizationRecommendationsQuery["surface"]) {
    const tracks = entities.filter((item) => item.entityKind === "track" && (item.provider === provider || !item.provider)).sort((left, right) => entityScore(right) - entityScore(left));
    const libraryCandidates = tracks.map(entityToCandidate).filter((item): item is ProviderTrackCandidate => item !== null)
      .map((candidate) => ({ candidate, source: "library" as const, baseScore: 0.9, interestKey: "library", interestLabel: null }));
    return {
      candidates: dedupeCandidates(libraryCandidates),
      playlists: []
    };
  }



  private async projectTrack(transaction: Prisma.TransactionClient, userId: string, track: PersonalizationTrackInput, score: number, occurredAt: Date, incrementInteraction: boolean, timezoneOffsetMinutes = 0) {
    await this.projectEntity(transaction, userId, "track", trackKey(track), { provider: track.provider, providerItemId: track.providerTrackId, providerAlbumId: track.providerAlbumId ?? null, access: track.access, quality: track.quality, title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs, artworkUrl: track.artworkUrl, score, occurredAt, incrementInteraction });
    await this.projectEntity(transaction, userId, "artist", normalizeText(track.artist), { title: track.artist, score: score * 0.55, occurredAt, incrementInteraction });
    if (track.album) await this.projectEntity(transaction, userId, "album", `${track.provider}:${track.providerAlbumId ?? normalizeText(track.album)}`, { provider: track.provider, providerItemId: track.providerAlbumId ?? null, title: track.album, artist: track.artist, album: track.album, durationMs: track.durationMs, artworkUrl: track.artworkUrl, score: score * 0.25, occurredAt, incrementInteraction });
    const evidence = [...extractTasteEvidence(track), ...inferBehavioralSceneEvidence(occurredAt, timezoneOffsetMinutes)];
    for (const item of evidence) {
      await this.projectEntity(transaction, userId, item.dimension, `${item.source}:${normalizeText(item.label)}`, {
        title: item.label,
        score: score * item.confidence * 0.35,
        confidence: item.confidence,
        occurredAt,
        incrementInteraction
      });
    }
    await this.projectEntity(transaction, userId, "source", track.provider, { title: track.provider, score: score * 0.1, occurredAt, incrementInteraction });
  }

  private async projectEntity(transaction: Prisma.TransactionClient, userId: string, kind: TasteEntityKind, key: string, input: Record<string, unknown> & { score: number; confidence?: number; occurredAt: Date; incrementInteraction?: boolean; retainScore?: boolean }) {
    const positiveScore = Math.max(0, input.score);
    const negativeScore = Math.max(0, -input.score);
    const data = {
      provider: typeof input.provider === "string" ? input.provider : null,
      providerItemId: typeof input.providerItemId === "string" ? input.providerItemId : null,
      providerAlbumId: typeof input.providerAlbumId === "string" ? input.providerAlbumId : null,
      access: typeof input.access === "string" ? input.access : null,
      quality: typeof input.quality === "string" ? input.quality : null,
      title: typeof input.title === "string" ? input.title : null,
      artist: typeof input.artist === "string" ? input.artist : null,
      album: typeof input.album === "string" ? input.album : null,
      durationMs: typeof input.durationMs === "number" ? input.durationMs : 0,
      artworkUrl: typeof input.artworkUrl === "string" ? input.artworkUrl : null,
      lastOccurredAt: input.occurredAt
    };
    const existing = await transaction.userTasteEntity.findUnique({
      where: { userId_entityKind_entityKey: { userId, entityKind: kind, entityKey: key } }
    });
    if (!existing) {
      await transaction.userTasteEntity.create({
        data: {
          id: `taste_entity_${randomUUID()}`,
          userId,
          entityKind: kind,
          entityKey: key,
          ...data,
          positiveScore,
          negativeScore,
          confidence: Math.min(1, input.confidence ?? Math.abs(input.score) / 7),
          interactionCount: 1
        }
      });
      return;
    }
    // Incremental half-life decay: stored scores are aged down to the new
    // event time before the fresh weight is added. Without this, long-term
    // scores grew unbounded and crowded out all exploration.
    const elapsedMs = Math.max(0, input.occurredAt.getTime() - (existing.lastOccurredAt?.getTime() ?? input.occurredAt.getTime()));
    const decay = Math.pow(0.5, elapsedMs / longTermHalfLifeMs);
    await transaction.userTasteEntity.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(input.retainScore
          ? { positiveScore: Math.max(0, positiveScore), negativeScore: Math.max(0, negativeScore) }
          : {
              positiveScore: existing.positiveScore * decay + positiveScore,
              negativeScore: existing.negativeScore * decay + negativeScore
            }),
        confidence: Math.min(1, existing.confidence + Math.min(0.1, input.confidence ?? Math.abs(input.score) * 0.04)),
        interactionCount: { increment: input.retainScore || input.incrementInteraction === false ? 0 : 1 }
      }
    });
  }

  /**
   * Recent recommendations live in Redis only: creating taste entities for
   * tracks the user never played polluted the profile table and grew it with
   * every discover request. The ranking engine applies the repetition penalty
   * through the key set below.
   */
  private async markRecommended(userId: string, tracks: ProviderTrackCandidate[]) {
    if (tracks.length === 0 || !this.redis.isAvailable()) return;
    const key = `personalization:recommended:${userId}`;
    try {
      await this.redis.client.sadd(key, ...tracks.map((candidate) => trackKey(candidate)));
      await this.redis.client.expire(key, recommendedRememberSeconds);
    } catch {
      // Forgetting a repetition penalty is harmless; never block the response.
    }
  }

  /**
   * Recall results are cached under a per-user epoch that only advances on
   * substantive taste changes. This keeps the cache warm during plain
   * listening (heartbeats never invalidate) and avoids KEYS scans entirely —
   * superseded epoch keys simply expire by TTL.
   */
  private async bumpRecallEpoch(userId: string) {
    const key = `personalization:recall-epoch:${userId}`;
    if (!this.redis.isAvailable()) {
      this.recallEpochFallback.set(userId, (this.recallEpochFallback.get(userId) ?? 0) + 1);
      return;
    }
    try {
      await this.redis.client.incr(key);
      await this.redis.client.expire(key, recallEpochSeconds);
    } catch {
      this.recallEpochFallback.set(userId, (this.recallEpochFallback.get(userId) ?? 0) + 1);
    }
  }

  private async getRecallEpoch(userId: string): Promise<number> {
    if (!this.redis.isAvailable()) {
      return this.recallEpochFallback.get(userId) ?? 0;
    }
    try {
      const value = await this.redis.client.get(`personalization:recall-epoch:${userId}`);
      const parsed = value ? Number(value) : 0;
      return Number.isFinite(parsed) ? parsed : this.recallEpochFallback.get(userId) ?? 0;
    } catch {
      return this.recallEpochFallback.get(userId) ?? 0;
    }
  }

  /**
   * Merge aged duplicate playback rows of the same track into their oldest
   * row (listening time and weight accumulate), keeping the event table
   * proportional to distinct listening history instead of raw sessions.
   * Completion/quick-skip rows are left untouched: the behavior tag ratios
   * depend on them staying separate.
   */
  private async compactPlaybackEvents(userId: string) {
    const cutoff = new Date(Date.now() - compactionCutoffDays * 24 * 60 * 60 * 1_000);
    const rows = await this.prisma.userTasteEvent.findMany({
      where: { userId, eventType: "playback", occurredAt: { lt: cutoff } },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      // 单轮压缩有界,历史遗留由后续轮次继续收敛
      take: 2_000
    });
    if (rows.length < 2) return;

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.entityKey) ?? [];
      group.push(row);
      groups.set(row.entityKey, group);
    }

    const operations: Prisma.PrismaPromise<unknown>[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keeper = group[0]!;
      const mergedListenedMs = group.reduce((total, row) => total + row.listenedMs, BigInt(0));
      const mergedWeight = group.reduce((total, row) => total + row.weight, 0);
      operations.push(
        this.prisma.userTasteEvent.update({
          where: { id: keeper.id },
          data: { listenedMs: mergedListenedMs, weight: mergedWeight }
        }),
        this.prisma.userTasteEvent.deleteMany({
          where: { id: { in: group.slice(1).map((row) => row.id) } }
        })
      );
    }
    if (operations.length > 0) {
      await this.prisma.$transaction(operations);
    }
  }

  private assertDatabaseAvailable() {
    if (!this.prisma.isAvailable()) throw new ServiceUnavailableException("Personalization storage is temporarily unavailable.");
  }
}

export { buildTopArtists } from "./personalization.helpers";

