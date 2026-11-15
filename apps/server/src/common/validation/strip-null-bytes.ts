/**
 * Removes NUL (\u0000) bytes from strings recursively before persisting to
 * PostgreSQL text or jsonb columns, which reject NUL bytes with SQLSTATE 22P05.
 */
export function stripNullBytes<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("\u0000") ? value.replaceAll("\u0000", "") : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNullBytes(item)) as T;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      stripNullBytes(item)
    ]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}
