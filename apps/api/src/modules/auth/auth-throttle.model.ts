import { Schema, model } from "mongoose";

/**
 * Shared, MongoDB-backed fixed-window counter. Deliberately NOT
 * process-local (no `Map`/module-level counters) because this API runs as
 * multiple concurrent Vercel instances that share nothing but the
 * database. See docs/api.md "Throttling" for the exact policy.
 *
 * One document per (key, window). `count` is incremented atomically via
 * `$inc` inside an upsert, so concurrent requests across instances still
 * produce a correct count. `expiresAt` is a TTL index purely for cleanup;
 * the throttle decision itself is always made from `count`, never from
 * whether the document still exists.
 */
const throttleSchema = new Schema({
  key: { type: String, required: true },
  windowStart: { type: Date, required: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
});

throttleSchema.index({ key: 1, windowStart: 1 }, { unique: true });
throttleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface ThrottleDocument {
  key: string;
  windowStart: Date;
  count: number;
  expiresAt: Date;
}

export const AuthThrottle = model<ThrottleDocument>("AuthThrottle", throttleSchema);

/**
 * Atomically records one attempt for `key` in the fixed window containing
 * `now`, and returns the count for that window after recording it. Two
 * concurrent calls for the same key/window both get a correct,
 * strictly-increasing count — `$inc` on the matched document is atomic in
 * MongoDB, and the unique index prevents a duplicate window document from
 * ever being created under a concurrent upsert race (a losing upsert
 * throws a duplicate-key error, which is retried once as a plain
 * increment against the now-existing document).
 */
export async function recordAttempt(
  key: string,
  windowMs: number,
  now: Date = new Date()
): Promise<number> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);

  try {
    const doc = await AuthThrottle.findOneAndUpdate(
      { key, windowStart },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, new: true }
    );
    return doc.count;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const doc = await AuthThrottle.findOneAndUpdate(
        { key, windowStart },
        { $inc: { count: 1 } },
        { upsert: true, new: true }
      );
      return doc.count;
    }
    throw error;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
