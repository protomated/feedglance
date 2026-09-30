/**
 * Readable message from anything a promise rejected with.
 *
 * Tauri commands reject with the backend's error *string*, not an `Error`, so
 * an `instanceof Error` check alone hides the real reason behind a fallback.
 */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e.trim()) return e;
  return fallback;
}
