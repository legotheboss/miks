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
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  hidePathPrefix: "",
  notifications: true,
  sidebarVisible: true,
};
