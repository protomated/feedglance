export function isValidYouTrackCloudUrl(input: string): boolean {
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    return url.hostname.endsWith(".youtrack.cloud");
  } catch {
    return false;
  }
}

export function normalizeUrl(input: string): string {
  const url = input.startsWith("http") ? input : `https://${input}`;
  return url.replace(/\/+$/, "");
}
