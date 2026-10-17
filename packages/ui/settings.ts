// The app's settings, as the main process keeps them (packages/app/main.ts),
// live in every window: a change in Settings shows up everywhere at once.
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import { useSyncExternalStore } from "react";

const bridge = window.miks;
const listeners = new Set<() => void>();
let current: Settings = bridge?.getSettings() ?? DEFAULT_SETTINGS;

bridge?.onSettings((settings) => {
  current = settings;
  for (const listener of listeners) listener();
});

export function getSettings(): Settings {
  return current;
}

export function updateSettings(changes: Partial<Settings>) {
  bridge?.setSettings(changes);
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

export function setFontSize(size: number) {
  updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) });
}

/**
 * A directory for display: the home folder as `~`, and the "hide path
 * prefix" setting left off (`~/Code/sage` with `~/Code/` hidden is `sage`).
 */
export function displayPath(cwd: string, hidePrefix: string, home: string | null): string {
  const tilde = (p: string) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);
  const shown = tilde(cwd);

  const prefix = tilde(hidePrefix.trim()).replace(/\/+$/, "");
  if (!prefix) return shown;
  return shown.startsWith(prefix + "/") ? shown.slice(prefix.length + 1) : shown;
}
