import IORedis from "ioredis";
import { config } from "@ob/core";

/** Process-wide Redis client, shared by the rate limiter and the queue registry. */
let client: IORedis | undefined;

export function getRedis(): IORedis {
  client ??= new IORedis(config().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return client;
}
