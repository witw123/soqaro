import { RedisService } from "../../../infra/redis/redis.service";
import { RoomTerminationStore } from "./room-termination.store";
import { RoomTrackDeletionStore } from "./room-track-deletion.store";
import type { RoomTrackDeletion } from "@soqaro/shared";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { stripNullBytes } from "../../../common/validation/strip-null-bytes";
import {
  deserializeRoomRecord,
  normalizeRoomRecord,
  serializePlaybackForPersistence,
  type RoomRecord
} from "../room.types";

export class RoomRecordRepository {

  private readonly terminationStore: RoomTerminationStore;
  private readonly trackDeletionStore: RoomTrackDeletionStore;

  /** Freshness token per cached record, used to skip re-parsing unchanged DB rows. */
  private readonly cacheMeta = new Map<string, { roomRevision: number; updatedAtMs: number }>();

  /**
   * Tombstone 负缓存:近期刚确认过“未删除”的房间在短 TTL 内免于读路径上的
   * tombstone 查询。正结果(已删除)永不缓存;所有删除入口都会立即失效条目,
   * 因此最坏情况只是已删房间多存活一个 TTL 窗口。
   */

  constructor(
    private readonly rooms: Map<string, RoomRecord>,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly roomRegistryKey: string,
    private readonly roomCacheTtlSeconds: number,
    private readonly sessionRecentRoomTtlSeconds: number
  ) {
    this.terminationStore = new RoomTerminationStore(prisma, redis);
    this.trackDeletionStore = new RoomTrackDeletionStore(prisma, redis);
  }

  async findByJoinCode(joinCode: string) {
    const code = joinCode.trim().toUpperCase();

    if (this.prisma.isAvailable()) {
      const persisted = await this.prisma.roomState.findUnique({
        where: { joinCode: code }
      });

      if (persisted) {
        if (await this.isRoomTerminated(persisted.id)) {
          throw new Error(`Room not found for join code: ${joinCode}`);
        }
        let record: RoomRecord | null = null;
        try {
          record = parseRoomRecord(deserializeRoomRecord(persisted));
        } catch {
          record = null;
        }
        if (record) {
          this.trackCachedRecord(record.room.id, record.room.roomRevision ?? 0, persisted.updatedAt);
          this.rooms.set(record.room.id, cloneRoomRecord(record));
          // `record` is a fresh parse owned by the caller; the cache keeps its own copy.
          return record.room;
        }
      }

      // A room created while PostgreSQL was unavailable can still exist in the
      // Redis registry. listRecoverableRecords() migrates those records; keep
      // join-by-code compatible during the migration window as well.
    }

    if (this.isRedisAvailable()) {
      // joinCode 缓存只存 roomId(瘦身):房间本体按 roomId 走内存/roomCache。
      const cachedRoomId = await this.redis.getString(this.joinCodeCacheKey(code));
      if (cachedRoomId) {
        const cached = this.rooms.get(cachedRoomId);
        if (cached && cached.room.joinCode === code) {
          if (await this.isRoomTerminated(cachedRoomId)) {
            throw new Error(`Room not found for join code: ${joinCode}`);
          }
          return cloneRoomRecord(cached).room;
        }
        const redisRecord = await this.redis.getJson<unknown>(this.roomCacheKey(cachedRoomId));
        const parsedRedisRecord = parseRoomRecord(redisRecord);
        if (parsedRedisRecord && parsedRedisRecord.room.joinCode === code) {
          if (await this.isRoomTerminated(cachedRoomId)) {
            throw new Error(`Room not found for join code: ${joinCode}`);
          }
          this.rooms.set(cachedRoomId, cloneRoomRecord(parsedRedisRecord));
          return cloneRoomRecord(parsedRedisRecord).room;
        }
        await this.redis.delete(this.joinCodeCacheKey(code)).catch(() => undefined);
      }
    } else if (!this.prisma.isAvailable()) {
      const inMemoryRecord = [...this.rooms.values()].find(({ room }) => room.joinCode === code);
      if (inMemoryRecord) {
        return cloneRoomRecord(inMemoryRecord).room;
      }
    }

    throw new Error(`Room not found for join code: ${joinCode}`);
  }

  async getRoomRecord(roomId: string, options?: { allowTerminated?: boolean }) {
    const cached = this.rooms.get(roomId);
    let persistedFound = false;

    if (this.prisma.isAvailable()) {
      // 热路径:先用轻量探针(仅 id/roomRevision/updatedAt)校验进程内缓存的新鲜度,
      // 命中则免去整行读取、JSON 解析与克隆。探针未命中(行消失或已变更)再走整行读取。
      const meta = cached ? this.cacheMeta.get(roomId) : undefined;
      if (cached && meta) {
        const probe = await this.prisma.roomState
          .findUnique({
            where: { id: roomId },
            select: { id: true, roomRevision: true, updatedAt: true }
          })
          .catch(() => null);
        if (
          probe &&
          meta.roomRevision === probe.roomRevision &&
          meta.updatedAtMs === toMillis(probe.updatedAt)
        ) {
          if (!options?.allowTerminated && (await this.isRoomTerminated(roomId))) {
            throw new Error(`Room not found: ${roomId}`);
          }
          return cloneRoomRecord(cached);
        }
      }

      const persisted = await this.prisma.roomState.findUnique({
        where: { id: roomId }
      });

      if (persisted) {
        persistedFound = true;
        if (!options?.allowTerminated && await this.isRoomTerminated(roomId)) {
          throw new Error(`Room not found: ${roomId}`);
        }
        let record: RoomRecord | null = null;
        try {
          record = parseRoomRecord(deserializeRoomRecord(persisted));
        } catch {
          record = null;
        }
        if (record) {
          this.trackCachedRecord(roomId, record.room.roomRevision ?? 0, persisted.updatedAt);
          this.rooms.set(roomId, cloneRoomRecord(record));
          // `record` is a fresh parse owned by the caller (callers may mutate it
          // before persisting); the cache keeps an isolated copy.
          return record;
        }
      }

      // A room created while PostgreSQL was unavailable can still exist in the
      // Redis registry. Do not use the process-local cache here, but allow the
      // durable Redis mirror to be recovered and migrated.
    }

    if (this.isRedisAvailable()) {
      const redisRecord = await this.redis.getJson<unknown>(this.roomCacheKey(roomId));
      const parsedRedisRecord = parseRoomRecord(redisRecord);
      if (parsedRedisRecord && parsedRedisRecord.room.id === roomId) {
        if (!options?.allowTerminated && await this.isRoomTerminated(roomId)) {
          throw new Error(`Room not found: ${roomId}`);
        }
        this.rooms.set(roomId, cloneRoomRecord(parsedRedisRecord));
        return cloneRoomRecord(parsedRedisRecord);
      }
    } else if ((!this.prisma.isAvailable() || persistedFound) && cached) {
      return cloneRoomRecord(cached);
    }

    throw new Error(`Room not found: ${roomId}`);
  }

  async persistRecord(record: RoomRecord) {
    if (await this.isRoomTerminated(record.room.id)) {
      throw new Error(`Room has been terminated: ${record.room.id}`);
    }

    const databaseAvailable = this.prisma.isAvailable();
    if (databaseAvailable) {
      await this.persistRecordToDatabase(record);
      // Prisma's @updatedAt is assigned client-side, so the persist timestamp
      // matches what a subsequent probe will read back. A mismatch only costs
      // one extra re-parse, never staleness.
      this.trackCachedRecord(record.room.id, record.room.roomRevision ?? 0, new Date());
    }

    const supportsRedisRevisionGuard =
      typeof this.redis.setJsonIfRevisionMatches === "function";
    if (!databaseAvailable && supportsRedisRevisionGuard) {
      const didPersist = await this.redis.setJsonIfRevisionMatches(
        this.roomCacheKey(record.room.id),
        record,
        (record.room.roomRevision ?? 0) - 1,
        this.roomCacheTtlSeconds
      );
      if (!didPersist) {
        throw new Error("Room state revision conflict.");
      }
    }

    await Promise.all([
      this.redis.addToSet(this.roomRegistryKey, record.room.id),
      ...(databaseAvailable || !supportsRedisRevisionGuard
        ? [
            this.redis.setJson(
              this.roomCacheKey(record.room.id),
              record,
              this.roomCacheTtlSeconds
            )
          ]
        : []),
      this.redis.setString(
        this.joinCodeCacheKey(record.room.joinCode),
        record.room.id,
        this.roomCacheTtlSeconds
      )
    ]);
    this.rooms.set(record.room.id, cloneRoomRecord(record));
  }

  async deleteRecord(record: RoomRecord) {
    this.terminationStore.invalidateNotTerminated(record.room.id);
    const databaseAvailable = this.prisma.isAvailable();
    let redisCleanupFailed = false;

    try {
      await Promise.all([
        this.redis.removeFromSet(this.roomRegistryKey, record.room.id),
        this.redis.delete(this.roomCacheKey(record.room.id)),
        this.redis.delete(this.joinCodeCacheKey(record.room.joinCode))
      ]);
    } catch {
      redisCleanupFailed = true;
      // PostgreSQL remains authoritative. A Redis outage must not leave the
      // durable room row alive, while Redis-only deployments still fail closed.
      if (!databaseAvailable) {
        throw new Error("Redis unavailable while deleting room.");
      }
    }

    if (databaseAvailable) {
      await this.prisma.roomState.deleteMany({
        where: { id: record.room.id }
      });
    }

    this.rooms.delete(record.room.id);

    // The stale Redis entry is ignored while PostgreSQL is healthy and will be
    // removed on the next Redis maintenance pass.
    void redisCleanupFailed;
  }

  async markRoomTerminated(record: RoomRecord, reason?: string) {
    await this.terminationStore.markRoomTerminated(
      record.room.id,
      record.tracks.map((track) => track.id),
      reason
    );
  }

  async completeRoomTermination(roomId: string) {
    await this.terminationStore.completeRoomTermination(roomId);
  }

  getRoomTermination(roomId: string) {
    return this.terminationStore.getRoomTermination(roomId);
  }

  recordTrackDeletion(deletion: RoomTrackDeletion) {
    return this.trackDeletionStore.recordTrackDeletion(deletion);
  }

  listTrackDeletions(roomId: string, sinceRevision = 0) {
    return this.trackDeletionStore.listTrackDeletions(roomId, sinceRevision);
  }

  private listTerminatedRoomIds() {
    return this.terminationStore.listTerminatedRoomIds();
  }

  private isRoomTerminated(roomId: string) {
    return this.terminationStore.isRoomTerminated(roomId);
  }

  /**
   * Rooms whose playback is currently "playing" — the only rooms the playback
   * watchdog needs. Uses a DB-side JSON filter instead of a full table scan,
   * and reuses the process-local cache for rows whose (roomRevision, updatedAt)
   * freshness token is unchanged.
   */
  async listPlayingRoomRecords() {
    const records = new Map<string, RoomRecord>();
    const databaseAvailable = this.prisma.isAvailable();

    if (databaseAvailable) {
      const persisted = await this.listPersistedRecords({ onlyPlaying: true });
      if (persisted.length > 0) {
        const terminatedRoomIds = await this.listTerminatedRoomIds();
        for (const record of persisted) {
          if (terminatedRoomIds.has(record.room.id)) {
            continue;
          }
          records.set(record.room.id, record);
        }
      }
    }

    if (!databaseAvailable) {
      for (const record of this.rooms.values()) {
        if (record.room.playback.status !== "playing") {
          continue;
        }
        if (await this.isRoomTerminated(record.room.id)) {
          continue;
        }
        records.set(record.room.id, record);
      }
    }

    if (databaseAvailable && this.isRedisAvailable()) {
      // Redis-only fallback rooms created while PostgreSQL was unavailable.
      const redisRoomIds = await this.redis.getSetMembers(this.roomRegistryKey);
      for (const roomId of redisRoomIds) {
        if (records.has(roomId)) {
          continue;
        }
        const rawRecord = await this.redis.getJson<unknown>(this.roomCacheKey(roomId));
        const record = parseRoomRecord(rawRecord);
        if (!record || record.room.id !== roomId || record.room.playback.status !== "playing") {
          continue;
        }
        if (await this.isRoomTerminated(roomId)) {
          continue;
        }
        this.rooms.set(roomId, cloneRoomRecord(record));
        records.set(roomId, record);
      }
    }

    return [...records.values()];
  }

  async listRecoverableRecords() {
    const records = new Map<string, RoomRecord>();
    const databaseAvailable = this.prisma.isAvailable();

    if (databaseAvailable) {
      const persisted = await this.listPersistedRecords();
      if (persisted.length > 0) {
        const terminatedRoomIds = await this.listTerminatedRoomIds();
        for (const record of persisted) {
          if (terminatedRoomIds.has(record.room.id)) {
            continue;
          }
          // Records are shared read-only cache entries; consumers must not
          // mutate them (write paths re-load via getRoomRecord, which returns
          // a caller-owned object).
          records.set(record.room.id, record);
        }
      }
    }

    if (!databaseAvailable) {
      for (const record of this.rooms.values()) {
        if (await this.isRoomTerminated(record.room.id)) {
          continue;
        }
        records.set(record.room.id, record);
      }
    }

    const redisAvailabilityKnown = typeof (this.redis as RedisService & { isAvailable?: () => boolean }).isAvailable === "function";
    const redisRoomIds = (!redisAvailabilityKnown || this.isRedisAvailable())
      ? await this.redis.getSetMembers(this.roomRegistryKey)
      : [];
    for (const roomId of redisRoomIds) {
      if (records.has(roomId)) {
        continue;
      }

      const rawRecord = await this.redis.getJson<unknown>(this.roomCacheKey(roomId));
      const record = parseRoomRecord(rawRecord);
      if (!record || record.room.id !== roomId || await this.isRoomTerminated(roomId)) {
        await this.redis.removeFromSet(this.roomRegistryKey, roomId);
        continue;
      }

      if (databaseAvailable) {
        // This is the compatibility path for rooms written by the previous
        // Redis-only fallback. Persist before returning so they survive the
        // Redis room-cache TTL and are visible on every future instance.
        await this.persistRecord(record).catch(() => undefined);
      }
      this.rooms.set(roomId, cloneRoomRecord(record));
      records.set(roomId, record);
    }

    return [...records.values()].sort(
      (left, right) =>
        new Date(right.room.playback.startedAt ?? 0).getTime() -
        new Date(left.room.playback.startedAt ?? 0).getTime()
    );
  }

  async clearRecentRoomForSessionIfMatching(sessionId: string, roomId: string) {
    const key = this.sessionRecentRoomKey(sessionId);
    let currentRoomId: string | null;
    try {
      currentRoomId = await this.redis.getString(key);
    } catch {
      // Recent-room cleanup is auxiliary. Room deletion must remain complete
      // even when Redis is temporarily unavailable.
      return;
    }

    if (currentRoomId === roomId) {
      await this.redis.delete(key).catch(() => undefined);
    }
  }

  async setRecentRoomForSession(sessionId: string, roomId: string) {
    await this.redis.setString(
      this.sessionRecentRoomKey(sessionId),
      roomId,
      this.sessionRecentRoomTtlSeconds
    );
  }

  sessionRecentRoomKey(sessionId: string) {
    return `soqaro:session:${sessionId}:recent-room`;
  }

  /**
   * Reads room rows from PostgreSQL using a two-phase freshness probe:
   *
   * 1. A cheap probe fetches only (id, roomRevision, updatedAt) for every row
   *    matching the optional filter — never the heavy track/queue JSON.
   * 2. Full rows are fetched (and zod-parsed) only for rooms whose freshness
   *    token changed or that are not cached yet; everything else is served
   *    from the process-local cache without re-parsing or cloning.
   *
   * Any DB-side change bumps @updatedAt (Prisma, client-side clock) or
   * roomRevision, so the probe cannot miss an update. Returning shared cached
   * records is safe because list consumers are read-only; mutation paths go
   * through getRoomRecord(), which hands out a caller-owned object.
   */
  private async listPersistedRecords(options: { onlyPlaying?: boolean } = {}) {
    const playbackFilter = options.onlyPlaying
      ? { playback: { path: ["status"], equals: "playing" } }
      : undefined;

    const probeRows = await this.prisma.roomState.findMany({
      ...(playbackFilter ? { where: playbackFilter } : {}),
      select: { id: true, roomRevision: true, updatedAt: true },
      orderBy: { updatedAt: "desc" }
    });

    if (probeRows.length === 0) {
      return [];
    }

    const staleIds: string[] = [];
    for (const row of probeRows) {
      const cached = this.rooms.get(row.id);
      const meta = this.cacheMeta.get(row.id);
      const isFresh =
        !!cached &&
        !!meta &&
        meta.roomRevision === row.roomRevision &&
        meta.updatedAtMs === toMillis(row.updatedAt);
      if (!isFresh) {
        staleIds.push(row.id);
      }
    }

    const hydratedRows = staleIds.length
      ? await this.prisma.roomState.findMany({
          where: {
            id: { in: staleIds },
            ...(playbackFilter ? { AND: [playbackFilter] } : {})
          },
          orderBy: { updatedAt: "desc" }
        })
      : [];
    const hydratedById = new Map(hydratedRows.map((row) => [row.id, row]));

    const records = new Map<string, RoomRecord>();
    for (const row of probeRows) {
      const cached = this.rooms.get(row.id);
      if (!staleIds.includes(row.id) && cached) {
        records.set(row.id, cached);
        continue;
      }

      const fullRow = hydratedById.get(row.id);
      if (!fullRow) {
        // Row vanished between probe and hydration; skip it.
        continue;
      }
      let record: RoomRecord | null = null;
      try {
        record = parseRoomRecord(deserializeRoomRecord(fullRow));
      } catch {
        // One legacy row must not hide every other room from the directory.
        record = null;
      }
      if (!record) {
        continue;
      }
      this.trackCachedRecord(record.room.id, record.room.roomRevision ?? 0, fullRow.updatedAt);
      this.rooms.set(record.room.id, record);
      records.set(record.room.id, record);
    }

    return [...records.values()];
  }

  private trackCachedRecord(roomId: string, roomRevision: number, updatedAt: unknown) {
    const updatedAtMs = toMillis(updatedAt);
    if (updatedAtMs === null) {
      this.cacheMeta.delete(roomId);
      return;
    }
    this.cacheMeta.set(roomId, { roomRevision, updatedAtMs });
  }

  private roomCacheKey(roomId: string) {
    return `soqaro:room:${roomId}`;
  }

  private joinCodeCacheKey(joinCode: string) {
    return `soqaro:join-code:${joinCode}`;
  }

  private isRedisAvailable() {
    const redisService = this.redis as RedisService & {
      isAvailable?: () => boolean;
    };
    return redisService.isAvailable?.() ?? false;
  }

  private async persistRecordToDatabase(record: RoomRecord) {
    const payload = stripNullBytes({
      hostId: record.room.hostId,
      joinCode: record.room.joinCode,
      name: record.room.name ?? "未命名房间",
      description: record.room.description ?? null,
      passwordHash: record.passwordHash ?? null,
      visibility: record.room.visibility,
      roomType: record.room.roomType,
      roomRevision: record.room.roomRevision ?? 0,
      presenceRevision: record.room.presenceRevision,
      playback: {
        ...serializePlaybackForPersistence(record.room),
        newMemberPermissions: record.room.newMemberPermissions ?? null,
        roomType: record.room.roomType,
        requests: record.requests ?? record.room.requests ?? [],
        memberPermissionProfiles: record.memberPermissionProfiles ?? {}
      },
      members: record.room.members,
      tracks: record.tracks,
      queue: record.queue
    });

    const updateResult = await this.prisma.roomState.updateMany({
      where: {
        id: record.room.id,
        roomRevision: (record.room.roomRevision ?? 0) - 1
      },
      data: payload
    });

    if (updateResult.count > 0) {
      return;
    }

    // Row either doesn't exist yet or a concurrent write updated it.
    // Check which case we're in to avoid a blind create race.
    const existing = await this.prisma.roomState.findUnique({
      where: { id: record.room.id },
      select: { id: true }
    });

    if (!existing) {
      try {
        await this.prisma.roomState.create({
          data: { id: record.room.id, ...payload }
        });
        return;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          // Another process created the room concurrently; retry the
          // optimistic update once so callers don't see a false conflict.
          const retryResult = await this.prisma.roomState.updateMany({
            where: {
              id: record.room.id,
              roomRevision: (record.room.roomRevision ?? 0) - 1
            },
            data: payload
          });
          if (retryResult.count > 0) {
            return;
          }
          throw new Error("Room state revision conflict.");
        }
        throw error;
      }
    }

    throw new Error("Room state revision conflict.");
  }
}

function cloneRoomRecord(record: RoomRecord): RoomRecord {
  return structuredClone(record);
}

function parseRoomRecord(value: unknown): RoomRecord | null {
  return normalizeRoomRecord(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

function toMillis(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
