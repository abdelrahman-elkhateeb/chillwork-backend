import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Password hashing uses Node's built-in scrypt (no extra dependency) rather
 * than bcrypt/argon2. scrypt is a well-reviewed, memory-hard KDF shipped in
 * every Node runtime, which matters here since this API must run on
 * Vercel's serverless Node runtime without native addons.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scryptAsync(plainPassword, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const [, saltHex, hashHex] = parts as [string, string, string];
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");

  const derivedKey = (await scryptAsync(plainPassword, salt, expected.length)) as Buffer;

  if (derivedKey.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, expected);
}
