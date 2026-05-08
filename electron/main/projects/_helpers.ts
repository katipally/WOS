/**
 * Internal helpers shared between projects/crud.ts and projects/manager.ts.
 * Not part of the public surface; do not re-export from index.ts.
 */

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
