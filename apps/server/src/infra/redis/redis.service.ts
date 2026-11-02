import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { buildRedisClientArgs, getRedisConnectionMode, type RedisConnectionMode } from "./redis.config";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly messageHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly mode: RedisConnectionMode = getRedisConnectionMode();
  private subscriberMessageHandlerAttached = false;
  readonly client = createRedisClient();
  readonly subscriber = createRedisClient();
  private readonly handleSubscriberMessage = (messageChannel: string, message: string) => {
    const handlers = this.messageHandlers.get(messageChannel);
    if (!handlers?.size) {
      return;
    }

    try {
      const payload = JSON.parse(message) as unknown;
      handlers.forEach((handler) => handler(payload));
    } catch (error) {
      this.logger.warn(`Failed to parse redis message on ${messageChannel}: ${String(error)}`);
    }
  };

  async onModuleInit() {
    this.registerLifecycleLogging(this.client, "publisher");
    this.registerLifecycleLogging(this.subscriber, "subscriber");
    this.attachSubscriberMessageHandler();
    await this.connectSafely(this.client, "publisher");
    await this.connectSafely(this.subscriber, "subscriber");
  }

  async onModuleDestroy() {
    this.subscriber.off("message", this.handleSubscriberMessage);
    await Promise.allSettled([this.client.quit(), this.subscriber.quit()]);
  }

  isAvailable() {
    return this.client.status === "ready";
  }

  isPubSubAvailable() {
    return this.client.status === "ready" && this.subscriber.status === "ready";
  }

  getMode() {
    return this.mode;
  }

  async ping(): Promise<number | null> {
    if (!this.client || !this.isAvailable()) return null;
    const start = Date.now();
    try {
      await this.client.ping();
      return Date.now() - start;
    } catch {
      return null;
    }
  }

  async publish(channel: string, payload: unknown) {
    this.assertReady(this.client, "publisher");

    await this.client.publish(channel, JSON.stringify(payload));
  }

  async setJson(key: string, payload: unknown, ttlSeconds?: number) {
    this.assertReady(this.client, "publisher");

    const value = JSON.stringify(payload);
    if (ttlSeconds) {
      await this.client.set(key, value, "EX", ttlSeconds);
      return;
    }

    await this.client.set(key, value);
  }

  async setJsonIfRevisionMatches(
    key: string,
    payload: unknown,
    expectedRevision: number,
    ttlSeconds?: number
  ) {
    this.assertReady(this.client, "publisher");

    const result = await this.client.eval(
      `local current = redis.call("GET", KEYS[1])
       if current then
         local ok, decoded = pcall(cjson.decode, current)
         if not ok or type(decoded) ~= "table" or type(decoded.room) ~= "table" then
           return -1
         end
         local currentRevision = tonumber(decoded.room.roomRevision)
         if currentRevision == nil or currentRevision ~= tonumber(ARGV[2]) then
           return 0
         end
       elseif tonumber(ARGV[2]) ~= -1 then
         return 0
       end
       if tonumber(ARGV[3]) > 0 then
         redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
       else
         redis.call("SET", KEYS[1], ARGV[1])
       end
       return 1`,
      1,
      key,
      JSON.stringify(payload),
      String(expectedRevision),
      String(ttlSeconds ?? 0)
    );

    return Number(result) === 1;
  }

  async claimJsonLease(key: string, payload: unknown, ttlMs: number) {
    this.assertReady(this.client, "publisher");

    const previous = await this.client.eval(
      `local current = redis.call("GET", KEYS[1])
       redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
       return current or ""`,
      1,
      key,
      JSON.stringify(payload),
      String(Math.max(1, Math.floor(ttlMs)))
    );
    if (typeof previous !== "string" || previous.length === 0) {
      return null;
    }

    try {
      return JSON.parse(previous) as unknown;
    } catch {
      return previous;
    }
  }

  async deleteJsonIfValue(key: string, expectedPayload: unknown) {
    this.assertReady(this.client, "publisher");

    const result = await this.client.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         return redis.call("DEL", KEYS[1])
       end
       return 0`,
      1,
      key,
      JSON.stringify(expectedPayload)
    );
    return Number(result) === 1;
  }

  async renewJsonLeaseIfValue(
    key: string,
    expectedPayload: unknown,
    ttlMs: number
  ) {
    this.assertReady(this.client, "publisher");

    const payload = JSON.stringify(expectedPayload);
    const result = await this.client.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
         return 1
       end
       return 0`,
      1,
      key,
      payload,
      String(Math.max(1, Math.floor(ttlMs)))
    );
    return Number(result) === 1;
  }

  async restoreJsonLeaseIfValue(
    key: string,
    expectedPayload: unknown,
    restorePayload: unknown,
    ttlMs: number
  ) {
    this.assertReady(this.client, "publisher");

    const result = await this.client.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
         return 1
       end
       return 0`,
      1,
      key,
      JSON.stringify(expectedPayload),
      JSON.stringify(restorePayload),
      String(Math.max(1, Math.floor(ttlMs)))
    );
    return Number(result) === 1;
  }

  async setString(key: string, value: string, ttlSeconds?: number) {
    this.assertReady(this.client, "publisher");

    if (ttlSeconds) {
      await this.client.set(key, value, "EX", ttlSeconds);
      return;
    }

    await this.client.set(key, value);
  }

  async setStringIfAbsent(key: string, value: string, ttlMs: number) {
    this.assertReady(this.client, "publisher");

    const result = await this.client.set(
      key,
      value,
      "PX",
      String(Math.max(1, Math.floor(ttlMs))),
      "NX"
    );
    return result === "OK";
  }

  async acquireLock(key: string, ttlMs: number) {
    this.assertReady(this.client, "publisher");

    const token = randomUUID();
    const result = await this.client.set(
      key,
      token,
      "PX",
      String(Math.max(1, Math.floor(ttlMs))),
      "NX"
    );

    return result === "OK" ? token : null;
  }

  async releaseLock(key: string, token: string) {
    this.assertReady(this.client, "publisher");

    const result = await this.client.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         return redis.call("DEL", KEYS[1])
       end
       return 0`,
      1,
      key,
      token
    );

    return Number(result) === 1;
  }

  async deleteStringIfValue(key: string, expectedValue: string) {
    this.assertReady(this.client, "publisher");

    const result = await this.client.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         return redis.call("DEL", KEYS[1])
       end
       return 0`,
      1,
      key,
      expectedValue
    );
    return Number(result) === 1;
  }

  async getString(key: string) {
    this.assertReady(this.client, "publisher");

    return this.client.get(key);
  }

  async getStrings(keys: string[]) {
    this.assertReady(this.client, "publisher");
    if (keys.length === 0) {
      return [];
    }

    return this.client.mget(...keys);
  }

  async getJson<T>(key: string): Promise<T | null> {
    this.assertReady(this.client, "publisher");

    const value = await this.client.get(key);
    if (!value) {
      return null;
    }

    return JSON.parse(value) as T;
  }

  async delete(key: string) {
    this.assertReady(this.client, "publisher");

    await this.client.del(key);
  }

  async addToSet(key: string, value: string) {
    this.assertReady(this.client, "publisher");

    await this.client.sadd(key, value);
  }

  async removeFromSet(key: string, value: string) {
    this.assertReady(this.client, "publisher");

    await this.client.srem(key, value);
  }

  async getSetMembers(key: string) {
    this.assertReady(this.client, "publisher");

    return this.client.smembers(key);
  }

  async addSortedSetScore(key: string, score: number, member: string) {
    this.assertReady(this.client, "publisher");
    await this.client.zadd(key, score, member);
  }

  async getSortedSetMembersByScore(key: string, min: number | string, max: number | string) {
    this.assertReady(this.client, "publisher");
    return this.client.zrangebyscore(key, min, max);
  }

  async removeSortedSetMembers(key: string, members: string[]) {
    this.assertReady(this.client, "publisher");
    if (members.length) await this.client.zrem(key, ...members);
  }

  async incrementWithTtlMs(key: string, ttlMs: number) {
    this.assertReady(this.client, "publisher");

    // Atomic INCR + fixed-window TTL in one step. The two-command version
    // (incr, then pexpire only on count === 1) leaves the key permanent if the
    // process dies or the connection drops between them, which rate-limits
    // that key forever. The TTL<0 branch also heals keys that were already
    // stranded without a TTL by an older deployment.
    return this.client.eval(
      `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      elseif redis.call('TTL', KEYS[1]) < 0 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      end
      return count
      `,
      1,
      key,
      String(ttlMs)
    ) as unknown as Promise<number>;
  }

  async subscribe(channel: string, handler: (payload: unknown) => void) {
    // ioredis queues SUBSCRIBE commands until the lazy connection is actually ready.
    const handlers = this.messageHandlers.get(channel) ?? new Set<(payload: unknown) => void>();
    const shouldSubscribe = handlers.size === 0;
    handlers.add(handler);
    this.messageHandlers.set(channel, handlers);

    if (shouldSubscribe) {
      await this.subscriber.subscribe(channel);
    }

    return async () => {
      const nextHandlers = this.messageHandlers.get(channel);
      if (!nextHandlers) {
        return;
      }

      nextHandlers.delete(handler);
      if (nextHandlers.size > 0) {
        return;
      }

      this.messageHandlers.delete(channel);
      if (this.subscriber.status === "ready") {
        await this.subscriber.unsubscribe(channel);
      }
    };
  }

  private async connectSafely(client: Redis, label: string) {
    try {
      if (client.status === "wait" || client.status === "close" || client.status === "end") {
        await client.connect();
      }
      this.logger.log(`Redis ${label} connected (mode=${this.mode})`);
    } catch (error) {
      this.logger.warn(`Redis ${label} unavailable; continuing without pub/sub. ${String(error)}`);
    }
  }

  private registerLifecycleLogging(client: Redis, label: string) {
    client.on("ready", () => {
      this.logger.log(`Redis ${label} ready`);
      if (client === this.subscriber) {
        this.attachSubscriberMessageHandler();
      }
    });
    client.on("error", (error) => {
      this.logger.warn(`Redis ${label} error: ${String(error)}`);
    });
    client.on("close", () => {
      this.logger.warn(`Redis ${label} connection closed`);
    });
    client.on("end", () => {
      this.logger.warn(`Redis ${label} connection ended`);
    });
    client.on("reconnecting", () => {
      this.logger.warn(`Redis ${label} reconnecting`);
    });
  }

  private assertReady(client: Redis, label: string) {
    if (client.status === "ready") {
      return;
    }

    throw new Error(`Redis unavailable (${label}).`);
  }

  private attachSubscriberMessageHandler() {
    if (this.subscriberMessageHandlerAttached) {
      return;
    }
    this.subscriber.on("message", this.handleSubscriberMessage);
    this.subscriberMessageHandlerAttached = true;
  }
}

function createRedisClient() {
  const args = buildRedisClientArgs();
  return args.length === 1 ? new Redis(args[0]) : new Redis(args[0], args[1]);
}
