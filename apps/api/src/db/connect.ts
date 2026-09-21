import mongoose from "mongoose";
import { env } from "../config/env.js";

/**
 * Cached connection state stored on globalThis so hot-reloads (tsx watch)
 * and, in the future, serverless invocations reuse a single connection
 * instead of opening a new one per request/module-load. Atlas M0 tiers
 * enforce very low connection limits, so this caching is required, not
 * just an optimization.
 */
interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __mongooseCache: MongooseCache | undefined;
}

const cache: MongooseCache = globalThis.__mongooseCache ?? { conn: null, promise: null };
globalThis.__mongooseCache = cache;

export async function connectDb(): Promise<typeof mongoose> {
  if (cache.conn) {
    return cache.conn;
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(env.MONGODB_URI, {
        maxPoolSize: 5,
      })
      .then((instance) => {
        cache.conn = instance;
        return instance;
      })
      .catch((error: unknown) => {
        // Reset the in-flight promise so the next call can retry the
        // connection instead of permanently reusing a rejected promise.
        cache.promise = null;
        throw error;
      });
  }

  return cache.promise;
}
