import { Redis } from "ioredis";
import config from "../config/env.js";

let client = null;

export const getRedis = () => {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    client.on("error", (err) => console.error("[redis] error:", err.message));
    client.on("connect", () => console.log("[redis] connected"));
  }
  return client;
};
