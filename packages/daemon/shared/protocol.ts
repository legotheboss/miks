// The wire contract between the daemon and its clients. Clients talk to the
// daemon over a WebSocket on its Unix socket, one JSON message per frame.
// This file is the only edge between the daemon and the UI.

/**
 * Bumped when a message changes shape or appears, so a UI talking to another
 * Mac's daemon can tell it's a different Miks. Before 2 there was none.
 */
export const PROTOCOL_VERSION = 2;

/**
 * What a coding agent in a pane is up to, as reported by its hooks.
 *
 * - `working`: busy on a prompt.
 * - `waiting`: blocked on you (a permission prompt, a question).
 * - `done`: finished a turn you haven't looked at yet.
 * - `idle`: running, nothing new.
 */
export type AgentStatus = "working" | "waiting" | "done" | "idle";

export type AgentState = {
  kind: "claude";
  status: AgentStatus;
  /** The agent's own words for why it's waiting, when it gave any. */
  message?: string;
  /** Epoch milliseconds of the last status change. */
  since: number;
};

export type Tab = {
  /** Also the pane's id; a tab holds exactly one pane for now. */
  id: string;
  /** The title the program set (OSC 0/2), or the shell's name. */
  title: string;
  /** Where the tab's shell is, checked every couple of seconds. */
  cwd: string | null;
  agent: AgentState | null;
  /** The program in front of the tab's shell, which closing it would stop; missing before protocol 2. */
  running?: string | null;
};

export type Workspace = {
  id: string;
  /** A name you gave it, or null to go by its active tab's title. */
  title: string | null;
  cwd: string;
  tabs: Tab[];
  activeTabId: string | null;
};

export type DaemonState = {
  /** The daemon's PROTOCOL_VERSION; missing before 2. */
  protocol?: number;
  /** The daemon's home directory, for showing paths with `~`. */
  home: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
};

//
// Client → daemon.
//

export type ClientMessage =
  /** Asks for the full state; the daemon answers with `state`. */
  | { type: "hello" }
  | { type: "createWorkspace"; cwd?: string; title?: string }
  | { type: "closeWorkspace"; workspaceId: string }
  /** An empty title goes back to following the active tab. */
  | { type: "renameWorkspace"; workspaceId: string; title: string }
  | { type: "createTab"; workspaceId: string }
  /** Moves a workspace to a position in the sidebar (counted without it). */
  | { type: "moveWorkspace"; workspaceId: string; index: number }
  /** Moves a tab to a position in its workspace's tab bar (counted without it). */
  | { type: "moveTab"; tabId: string; index: number }
  /** The UI's light or dark appearance, for programs that follow it. */
  | { type: "appearance"; dark: boolean }
  | { type: "closeTab"; tabId: string }
  /** Selecting a tab also marks its agent's `done` as seen. */
  | { type: "select"; workspaceId: string; tabId?: string }
  /** The tab is on screen in a focused window, so its `done` has been seen. */
  | { type: "seen"; tabId: string }
  /**
   * Starts streaming a pane: one `snapshot`, then `output` from exactly where
   * it left off. With a size, the pane is resized first; without one (a tab
   * that isn't on screen), it keeps its size and the snapshot reports it.
   */
  | { type: "attach"; tabId: string; cols?: number; rows?: number }
  | { type: "detach"; tabId: string }
  /**
   * A file dropped on a window on another Mac, which can't see the dropper's
   * paths: the daemon saves it and answers `uploaded` with where.
   */
  | { type: "upload"; tabId: string; name: string; data: string }
  /** The UI cleared its terminal (⌘K); the daemon's copy follows. */
  | { type: "clear"; tabId: string }
  | { type: "input"; tabId: string; data: string }
  | { type: "resize"; tabId: string; cols: number; rows: number };

//
// Daemon → client.
//

export type DaemonMessage =
  | { type: "state"; state: DaemonState }
  /** The pane's screen and scrollback as VT sequences, to write into a fresh terminal. */
  | { type: "snapshot"; tabId: string; data: string; cols: number; rows: number }
  | { type: "output"; tabId: string; data: string }
  /** Where an `upload` landed, on the daemon's Mac; null if it couldn't be saved. */
  | { type: "uploaded"; tabId: string; path: string | null };

// A pane whose program exits simply disappears from the next `state`.
