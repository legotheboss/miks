// The app's preferences, kept by the Electron main process in settings.json
// and shared by every window (packages/app/main.ts).

export type Settings = {
  /** Terminal text size, in points. */
  fontSize: number;
  /** A path prefix (like `~/Code/`) the sidebar leaves off directories. */
  hidePathPrefix: string;
  /** Whether to notify when an agent finishes or needs you. */
  notifications: boolean;
  /** Whether the sidebar is showing (⌘B). */
  sidebarVisible: boolean;
  /** Whether the daemon, and every terminal, outlives quitting the app. */
  keepDaemonRunning: boolean;
  /** Whether Miks keeps its hooks in Claude Code's settings, for agent status. */
  claudeHooks: boolean;
  /** Whether Option sends Meta (⌥A as Escape-A, for zsh bindings) instead of typing å. */
  optionAsMeta: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  hidePathPrefix: "",
  notifications: true,
  sidebarVisible: true,
  keepDaemonRunning: false,
  claudeHooks: true,
  optionAsMeta: true,
};

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
