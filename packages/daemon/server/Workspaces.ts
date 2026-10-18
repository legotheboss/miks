import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { type AgentState, type DaemonState, PROTOCOL_VERSION, type Tab } from "../shared/protocol.ts";
import { Pane } from "./Pane.ts";

/** What survives a daemon restart, in `state.json`. */
/** How long a finished turn waits for its session to end before it's `done`. */
const DONE_DELAY = 1000;

export type SavedState = {
  version: 1;
  activeWorkspace: number;
  workspaces: {
    title: string | null;
    cwd: string;
    activeTab: number;
    tabs: { cwd: string; claudeSessionId?: string; historyId?: string; keep?: string }[];
  }[];
};

type WorkspaceRecord = {
  id: string;
  title: string | null;
  cwd: string;
  tabIds: string[];
  activeTabId: string | null;
};

/**
 * Everything the daemon knows: workspaces, the panes in their tabs, and what
 * the agents in those panes are doing. Emits `change` after any mutation that
 * clients should hear about.
 */
export class Workspaces extends EventEmitter<{ change: [] }> {
  private readonly workspaces: WorkspaceRecord[] = [];
  private activeWorkspaceId: string | null = null;
  private readonly panes = new Map<string, Pane>();
  private readonly agents = new Map<string, AgentState>();
  /** The Claude Code session in each tab, from its hooks, for resuming it. */
  private readonly claudeSessions = new Map<string, { id: string; transcriptPath?: string }>();
  /**
   * Commands run with `miks keep`, to run again if the tab is restored while
   * they still are. One stops being kept once its shell is back in front,
   * after having been seen running (it starts a moment after it registers).
   */
  private readonly keeps = new Map<string, { command: string; seenRunning: boolean }>();
  /** A finished turn waits a moment before it's `done` (see applyHook). */
  private readonly pendingDone = new Map<string, NodeJS.Timeout>();
  /** Each tab's own shell history file's name, kept across restores. */
  private readonly historyIds = new Map<string, string>();
  /** Each tab's shell's directory, as of the last `pollCwds`. */
  private readonly cwds = new Map<string, string>();
  private dark = true;
  /** Set by killAll: panes exiting now aren't to be replaced. */
  private stopping = false;

  private readonly socketPath: string;
  private readonly command?: string[];
  private readonly claudeCommand: string;

  constructor({
    socketPath,
    command,
    claudeCommand = "claude",
  }: {
    socketPath: string;
    command?: string[];
    /** What resumes a Claude session; tests substitute something harmless. */
    claudeCommand?: string;
  }) {
    super();
    this.socketPath = socketPath;
    this.command = command;
    this.claudeCommand = claudeCommand;
  }

  getState(): DaemonState {
    return {
      protocol: PROTOCOL_VERSION,
      home: os.homedir(),
      activeWorkspaceId: this.activeWorkspaceId,
      workspaces: this.workspaces.map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        cwd: workspace.cwd,
        activeTabId: workspace.activeTabId,
        tabs: workspace.tabIds.map((id) => this.getTab(id)),
      })),
    };
  }

  /** Programs running in front of a shell, with where: what quitting would stop. */
  running(): { program: string; cwd: string | null }[] {
    return this.workspaces.flatMap((workspace) =>
      workspace.tabIds.flatMap((id) => {
        const program = this.panes.get(id)?.running();
        return program ? [{ program, cwd: this.cwds.get(id) ?? null }] : [];
      }),
    );
  }

  getPane(tabId: string): Pane | undefined {
    return this.panes.get(tabId);
  }

  createWorkspace({ cwd = os.homedir(), title }: { cwd?: string; title?: string } = {}): string {
    const workspace: WorkspaceRecord = {
      id: shortId(),
      title: title ?? null,
      cwd,
      tabIds: [],
      activeTabId: null,
    };
    this.workspaces.push(workspace);
    this.activeWorkspaceId = workspace.id;
    this.createTab(workspace.id);
    return workspace.id;
  }

  closeWorkspace(workspaceId: string) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    // Each pane's exit removes its tab, and the last one removes the workspace.
    for (const tabId of workspace.tabIds) this.panes.get(tabId)?.kill();
  }

  renameWorkspace(workspaceId: string, title: string) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    workspace.title = title.trim() || null;
    this.emit("change");
  }

  /**
   * A new tab where you are: in the current tab's directory, asked of its
   * shell just now (the poll's could be seconds old), or the workspace's.
   */
  async newTab(workspaceId: string): Promise<string | undefined> {
    const activeTabId = this.findWorkspace(workspaceId)?.activeTabId;
    const pane = activeTabId ? this.panes.get(activeTabId) : undefined;
    const cwd = (await pane?.cwd()) ?? (activeTabId ? this.cwds.get(activeTabId) : undefined);
    return this.createTab(workspaceId, { cwd });
  }

  createTab(
    workspaceId: string,
    {
      cwd,
      resumeClaudeSession,
      keep,
      historyId = randomUUID(),
    }: { cwd?: string; resumeClaudeSession?: string; keep?: string; historyId?: string } = {},
  ): string | undefined {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    const id = shortId();
    const pane = new Pane({
      id,
      cwd: cwd ?? workspace.cwd,
      // A kept command first: a Claude session in such a tab is one it ran.
      command: keep
        ? this.thenShell(keep)
        : resumeClaudeSession
          ? this.thenShell(`${this.claudeCommand} --resume ${resumeClaudeSession}`)
          : this.command,
      dark: this.dark,
      env: { MIKS_PANE_ID: id, MIKS_SOCKET: this.socketPath, MIKS_HISTORY: this.historyFile(historyId) },
    });
    this.panes.set(id, pane);
    this.historyIds.set(id, historyId);
    if (keep) this.keeps.set(id, { command: keep, seenRunning: false });
    workspace.tabIds.push(id);
    workspace.activeTabId = id;

    pane.on("title", (title, previous) => {
      this.applyTitle(id, title, previous);
      this.emit("change");
    });
    pane.on("exit", () => this.removeTab(id));

    this.emit("change");
    return id;
  }

  closeTab(tabId: string) {
    this.panes.get(tabId)?.kill();
  }

  moveWorkspace(workspaceId: string, index: number) {
    const from = this.workspaces.findIndex((w) => w.id === workspaceId);
    if (from === -1) return;

    const [workspace] = this.workspaces.splice(from, 1);
    this.workspaces.splice(clamp(index, 0, this.workspaces.length), 0, workspace);
    this.emit("change");
  }

  moveTab(tabId: string, index: number) {
    const workspace = this.workspaces.find((w) => w.tabIds.includes(tabId));
    if (!workspace) return;

    workspace.tabIds.splice(workspace.tabIds.indexOf(tabId), 1);
    workspace.tabIds.splice(clamp(index, 0, workspace.tabIds.length), 0, tabId);
    this.emit("change");
  }

  setDark(dark: boolean) {
    this.dark = dark;
    for (const pane of this.panes.values()) pane.setDark(dark);
  }

  /** Notices programs starting and exiting in front, for tab titles. */
  pollForeground() {
    let changed = false;
    for (const pane of this.panes.values()) changed = pane.pollForeground() || changed;

    for (const [tabId, kept] of this.keeps) {
      if (this.panes.get(tabId)?.running()) kept.seenRunning = true;
      else if (kept.seenRunning) {
        this.keeps.delete(tabId);
        changed = true;
      }
    }

    if (changed) this.emit("change");
  }

  /** `miks keep <command>` in a tab: run it again if the tab is restored. */
  keep(tabId: string, command: string) {
    if (!this.panes.has(tabId) || !command.trim()) return;
    this.keeps.set(tabId, { command, seenRunning: false });
    this.emit("change");
  }

  /**
   * Refreshes every tab's directory with one `lsof` for all the shells, since
   * nothing tells us when a shell cd's. Emits `change` only if one moved.
   */
  async pollCwds() {
    const panes = [...this.panes.values()];
    if (panes.length === 0) return;

    const byPid = await shellCwds(panes.map((pane) => pane.pid));
    let changed = false;
    for (const pane of panes) {
      const cwd = byPid.get(pane.pid);
      if (!cwd || this.cwds.get(pane.id) === cwd) continue;
      this.cwds.set(pane.id, cwd);
      changed = true;
    }
    if (changed) this.emit("change");
  }

  select(workspaceId: string, tabId?: string) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    this.activeWorkspaceId = workspace.id;
    if (tabId && workspace.tabIds.includes(tabId)) workspace.activeTabId = tabId;
    if (workspace.activeTabId) this.markSeen(workspace.activeTabId);

    this.emit("change");
  }

  markSeen(tabId: string) {
    const agent = this.agents.get(tabId);
    if (agent?.status !== "done") return;

    this.agents.set(tabId, { ...agent, status: "idle", since: Date.now() });
    this.emit("change");
  }

  /**
   * Applies a Claude Code hook event, posted by the hook script with the
   * hook's own JSON payload (see `hooks/claude-hook.sh`).
   */
  applyHook(tabId: string, payload: any) {
    if (!this.panes.has(tabId)) return;

    const event: string | undefined = payload?.hook_event_name;
    // Session IDs are UUIDs; anything else isn't one we'd put in a command.
    const sessionId = payload?.session_id;
    if (typeof sessionId === "string" && /^[\w-]+$/.test(sessionId)) {
      const transcriptPath = typeof payload?.transcript_path === "string" ? payload.transcript_path : undefined;
      this.claudeSessions.set(tabId, { id: sessionId, transcriptPath });
    }

    const set = (status: AgentState["status"], message?: string) =>
      this.agents.set(tabId, { kind: "claude", status, message, since: Date.now() });

    // Whatever comes next supersedes a turn waiting to be `done`.
    clearTimeout(this.pendingDone.get(tabId));
    this.pendingDone.delete(tabId);

    switch (event) {
      case "SessionStart":
        set("idle");
        break;
      case "UserPromptSubmit":
      case "PostToolUse":
        // PostToolUse is what moves us off `waiting` once a permission
        // prompt is approved and the tool has run.
        set("working");
        break;
      case "Notification":
        // The idle reminder ("Claude is waiting for your input") arrives a
        // minute after a turn ends. `done` already covers a finished turn,
        // but it also catches one that ended without saying so.
        if (payload?.notification_type === "idle_prompt") {
          if (this.agents.get(tabId)?.status !== "working") return;
          set("idle");
          break;
        }
        set("waiting", payload?.message);
        break;
      case "Stop": {
        // A one-shot `claude -p` (a script's, say) ends its session right
        // after its turn, 25ms later in practice; nothing for you to see, so
        // no `done` (and no notification). An interactive session stays.
        const timer = setTimeout(() => {
          this.pendingDone.delete(tabId);
          if (!this.agents.has(tabId)) return;
          set("done");
          this.emit("change");
        }, DONE_DELAY);
        timer.unref();
        this.pendingDone.set(tabId, timer);
        return;
      }
      case "SessionEnd":
        this.agents.delete(tabId);
        this.claudeSessions.delete(tabId);
        break;
      default:
        return;
    }

    this.emit("change");
  }

  /**
   * Claude Code animates its title (◐ ◑) while a turn runs and shows ✳ when
   * it stops. Interrupting with Esc fires no hook at all, so the spinner
   * stopping is how we hear about it: the turn is over, and since you ended
   * it yourself there's nothing new to see. Only the change from spinning to
   * ✳ counts, never a ✳ on its own, which can trail a prompt just submitted.
   */
  private applyTitle(tabId: string, title: string, previous: string) {
    const agent = this.agents.get(tabId);
    if (agent?.status !== "working") return;
    if (!CLAUDE_IDLE_TITLE.test(title) || !CLAUDE_WORKING_TITLE.test(previous)) return;

    this.agents.set(tabId, { ...agent, status: "idle", message: undefined, since: Date.now() });
  }

  /**
   * The layout as it stands, with each tab's current directory (where its
   * shell has cd'ed to, not where it started) and its Claude session, if any.
   */
  async save(): Promise<SavedState> {
    const workspaces = await Promise.all(
      this.workspaces.map(async (workspace) => ({
        title: workspace.title,
        cwd: workspace.cwd,
        activeTab: Math.max(0, workspace.tabIds.indexOf(workspace.activeTabId ?? "")),
        tabs: await Promise.all(
          workspace.tabIds.map(async (tabId) => ({
            cwd: (await this.panes.get(tabId)?.cwd()) ?? workspace.cwd,
            claudeSessionId: this.resumableSession(tabId),
            historyId: this.historyIds.get(tabId),
            keep: this.keeps.get(tabId)?.command,
          })),
        ),
      })),
    );

    return {
      version: 1,
      activeWorkspace: Math.max(0, this.workspaces.findIndex((w) => w.id === this.activeWorkspaceId)),
      workspaces,
    };
  }

  /**
   * Rebuilds a saved layout with fresh shells, each in its tab's directory.
   * A tab that had a Claude session resumes it, so a daemon restart costs a
   * moment, not your agents.
   */
  restore(saved: SavedState) {
    for (const savedWorkspace of saved.workspaces) {
      if (savedWorkspace.tabs.length === 0) continue;

      const workspace: WorkspaceRecord = {
        id: shortId(),
        title: savedWorkspace.title,
        cwd: savedWorkspace.cwd,
        tabIds: [],
        activeTabId: null,
      };
      this.workspaces.push(workspace);

      for (const tab of savedWorkspace.tabs) {
        this.createTab(workspace.id, {
          cwd: tab.cwd,
          resumeClaudeSession: tab.claudeSessionId,
          keep: tab.keep,
          historyId: tab.historyId,
        });
      }
      workspace.activeTabId = workspace.tabIds[savedWorkspace.activeTab] ?? workspace.tabIds[0] ?? null;
    }

    this.activeWorkspaceId = this.workspaces[saved.activeWorkspace]?.id ?? this.workspaces[0]?.id ?? null;
    this.emit("change");

    // Histories of tabs that didn't come back (a crash lost their state).
    const kept = new Set([...this.historyIds.values()].map((id) => `${id}.zsh`));
    try {
      for (const file of fs.readdirSync(this.historyDir())) {
        if (!kept.has(file)) fs.rmSync(path.join(this.historyDir(), file), { force: true });
      }
    } catch {}
  }

  /**
   * Where a tab's own shell history goes (Miks's zsh startup files keep it):
   * the commands it ran, read back when the tab is restored, so ↑ picks up
   * where you were in that tab.
   */
  private historyDir(): string {
    return path.join(path.dirname(this.socketPath), "history");
  }

  private historyFile(historyId: string): string {
    fs.mkdirSync(this.historyDir(), { recursive: true, mode: 0o700 });
    return path.join(this.historyDir(), `${historyId}.zsh`);
  }

  /**
   * The tab's Claude session, if there's anything to resume. Claude Code only
   * writes a transcript once the session has a message (and never for a child
   * session); resuming one without fails with "No conversation found".
   */
  private resumableSession(tabId: string): string | undefined {
    const session = this.claudeSessions.get(tabId);
    if (!session) return;
    if (session.transcriptPath && !fs.existsSync(session.transcriptPath)) return;
    return session.id;
  }

  /**
   * Resumes a Claude session, then leaves you in an ordinary shell when it
   * exits. Interactive as well as login, so the shell reads .zshrc, which is
   * often where `claude` gets onto the PATH.
   */
  private thenShell(command: string): string[] {
    const shell = this.command?.[0] ?? (process.env.SHELL || "/bin/zsh");
    return [shell, "-ilc", `${command}; exec ${shell} -l`];
  }

  /** Ends every pane. For tests; the real daemon just exits. */
  killAll() {
    this.stopping = true;
    for (const timer of this.pendingDone.values()) clearTimeout(timer);
    for (const pane of this.panes.values()) pane.kill();
  }

  private getTab(id: string): Tab {
    return {
      id,
      title: this.panes.get(id)?.displayTitle ?? "",
      cwd: this.cwds.get(id) ?? null,
      agent: this.agents.get(id) ?? null,
      running: this.panes.get(id)?.running() ?? null,
      kept: this.keeps.has(id) || !!this.resumableSession(id),
    };
  }

  private removeTab(tabId: string) {
    // Closed for good, not just stopping with the daemon: its history goes.
    const historyId = this.historyIds.get(tabId);
    if (historyId && !this.stopping) fs.rmSync(this.historyFile(historyId), { force: true });
    this.historyIds.delete(tabId);
    this.keeps.delete(tabId);
    clearTimeout(this.pendingDone.get(tabId));
    this.pendingDone.delete(tabId);
    this.panes.delete(tabId);
    this.agents.delete(tabId);
    this.claudeSessions.delete(tabId);
    this.cwds.delete(tabId);

    const workspace = this.workspaces.find((w) => w.tabIds.includes(tabId));
    if (workspace) {
      const index = workspace.tabIds.indexOf(tabId);
      workspace.tabIds.splice(index, 1);

      if (workspace.activeTabId === tabId) {
        // Like closing a browser tab: land on its right-hand neighbor.
        workspace.activeTabId = workspace.tabIds[Math.min(index, workspace.tabIds.length - 1)] ?? null;
      }

      if (workspace.tabIds.length === 0) this.removeWorkspace(workspace.id);
    }

    this.emit("change");
  }

  private removeWorkspace(workspaceId: string) {
    const index = this.workspaces.findIndex((w) => w.id === workspaceId);
    if (index === -1) return;

    this.workspaces.splice(index, 1);

    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = this.workspaces[Math.min(index, this.workspaces.length - 1)]?.id ?? null;
    }

    // Nothing to see in no workspaces at all, so closing the last starts afresh.
    if (this.workspaces.length === 0 && !this.stopping) this.createWorkspace();
  }

  private findWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.workspaces.find((w) => w.id === workspaceId);
  }
}

// Claude Code's title glyphs: half circles while working (braille in older
// versions), ✳ when idle.
const CLAUDE_WORKING_TITLE = /^[◐◑◒◓\u2800-\u28ff]/u;
const CLAUDE_IDLE_TITLE = /^✳/u;

/** The working directory of each process, by pid, in one `lsof` call. */
function shellCwds(pids: number[]): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], (_error, stdout) => {
      // lsof exits non-zero if any pid is gone, but still reports the rest.
      const cwds = new Map<number, string>();
      let pid = 0;
      for (const line of (stdout ?? "").split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
      }
      resolve(cwds);
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}
