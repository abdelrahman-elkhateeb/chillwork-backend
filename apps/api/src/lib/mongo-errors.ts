/** True for a MongoDB duplicate-key error (E11000), from any unique index. */
export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
