// The terminal font size, shared by every terminal and remembered across
// reloads. A per-viewer preference, so localStorage is the right home.
import { useSyncExternalStore } from "react";

export const DEFAULT_FONT_SIZE = 13;
const MIN = 8;
const MAX = 32;
const KEY = "miks.fontSize";

const listeners = new Set<() => void>();
let size = load();

function load(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    return stored >= MIN && stored <= MAX ? stored : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function setFontSize(next: number) {
  size = Math.min(MAX, Math.max(MIN, next));
  try {
    localStorage.setItem(KEY, String(size));
  } catch {
    // Unpersisted is fine; it still applies until the next reload.
  }
  for (const listener of listeners) listener();
}

export function getFontSize(): number {
  return size;
}

export function useFontSize(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => size,
  );
}
