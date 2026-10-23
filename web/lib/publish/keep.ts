/**
 * The one value graft may keep in a browser, and only when the maker chooses: the manage keys of
 * their own publications, by id. Every call tolerates storage that is missing, blocked or full.
 */
export const STORAGE_KEY = "graft.manage-keys";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function keptKeys(storage: StorageLike | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function keepKey(storage: StorageLike | null, id: string, key: string): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...keptKeys(storage), [id]: key }));
    return true;
  } catch {
    return false;
  }
}

export function forgetKey(storage: StorageLike | null, id: string): void {
  try {
    const rest = keptKeys(storage);
    delete rest[id];
    if (Object.keys(rest).length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    /* nothing to forget in storage that cannot be read */
  }
}
