// The wire contract between the daemon and its clients. Clients talk to the
// daemon over a WebSocket on its Unix socket, one JSON message per frame.
// This file is the only edge between the daemon and the UI.

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
  agent: AgentState | null;
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
  | { type: "input"; tabId: string; data: string }
  | { type: "resize"; tabId: string; cols: number; rows: number };

//
// Daemon → client.
//

export type DaemonMessage =
  | { type: "state"; state: DaemonState }
  /** The pane's screen and scrollback as VT sequences, to write into a fresh terminal. */
  | { type: "snapshot"; tabId: string; data: string; cols: number; rows: number }
  | { type: "output"; tabId: string; data: string };

// A pane whose program exits simply disappears from the next `state`.
