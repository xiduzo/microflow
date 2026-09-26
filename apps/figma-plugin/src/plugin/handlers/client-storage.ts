/** The stored value for `key`; when nothing is stored yet, `fallback` is stored and returned. */
export async function loadLocalValue(key: string, fallback?: unknown): Promise<unknown> {
  const stored: unknown = await figma.clientStorage.getAsync(key);
  if (stored != null) return stored;
  if (fallback !== undefined) await figma.clientStorage.setAsync(key, fallback);
  return fallback;
}
