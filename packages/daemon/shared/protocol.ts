// The wire contract between the daemon and its clients. Clients talk to the
// daemon over a WebSocket on its Unix socket, one JSON message per frame.
// This file is the only edge between the daemon and the UI.

/**
 * Bumped when a message changes shape or appears, so a UI talking to another
 * Mac's daemon can tell it's a different Miks. Before 2 there was none.
 */
export const PROTOCOL_VERSION = 6;

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
  /** How many lines the turn that just ended replied with. Since protocol 5. */
  replyLines?: number;
};

/**
 * One thing in a tab's Claude Code conversation, as the chat panel shows it,
 * read from the session's transcript. Since protocol 5.
 *
 * - `prompt`: what you sent.
 * - `reply`: Claude's text, as markdown.
 * - `tool`: a tool call: its name, a line saying what it did, and, when
 *   there's more to it, the details (a command, an edit).
 */
export type ChatEntry =
  | { id: string; kind: "prompt"; text: string; time: number }
  | { id: string; kind: "reply"; text: string; time: number }
  | { id: string; kind: "tool"; name: string; summary: string; detail?: string; time: number };

export type Tab = {
  /** Also the pane's id; a tab holds exactly one pane for now. */
  id: string;
  /**
   * The same tab across daemon restarts, unlike `id` (a new pane each
   * time): for what the UI keeps about a tab, like its chat draft. Since
   * protocol 6.
   */
  key?: string;
  /** The title the program set (OSC 0/2), or the shell's name. */
  title: string;
  /** Where the tab's shell is, checked every couple of seconds. */
  cwd: string | null;
  agent: AgentState | null;
  /** The program in front of the tab's shell, which closing it would stop; missing before protocol 2. */
  running?: string | null;
  /** Whether a restore brings back what's running (`miks keep`, or a Claude session). Since protocol 3. */
  kept?: boolean;
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
   * Starts sending the tab's Claude Code conversation: one `chat` with all of
   * it, then a `chat` with each new entry. Since protocol 5.
   */
  | { type: "watchChat"; tabId: string }
  | { type: "unwatchChat"; tabId: string }
  /**
   * From the Mac's own Miks: true when it quit while a window on another Mac
   * still had the daemon, which then stops once the last window goes; false
   * when it's back, taking the daemon over again. Since protocol 3.
   */
  | { type: "stopWhenIdle"; value: boolean }
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
  /**
   * Entries in the tab's conversation. With `reset`, the whole of it (on
   * watching, or when the tab's session changes); otherwise more to append.
   * `session` is the Claude Code session's ID, or null when the tab has none.
   */
  | { type: "chat"; tabId: string; session: string | null; entries: ChatEntry[]; reset: boolean };

// A pane whose program exits simply disappears from the next `state`.
