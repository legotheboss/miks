import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import type { AgentState, DaemonState, Tab } from "../shared/protocol.ts";
import { Pane } from "./Pane.ts";

/** What survives a daemon restart, in `state.json`. */
export type SavedState = {
  version: 1;
  activeWorkspace: number;
  workspaces: {
    title: string | null;
    cwd: string;
    activeTab: number;
    tabs: { cwd: string; claudeSessionId?: string }[];
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
  /** Each tab's shell's directory, as of the last `pollCwds`. */
  private readonly cwds = new Map<string, string>();
  private dark = true;

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

  createTab(
    workspaceId: string,
    { cwd, resumeClaudeSession }: { cwd?: string; resumeClaudeSession?: string } = {},
  ): string | undefined {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    const id = shortId();
    const pane = new Pane({
      id,
      cwd: cwd ?? workspace.cwd,
      command: resumeClaudeSession ? this.resumeCommand(resumeClaudeSession) : this.command,
      dark: this.dark,
      env: { MIKS_PANE_ID: id, MIKS_SOCKET: this.socketPath },
    });
    this.panes.set(id, pane);
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
    if (changed) this.emit("change");
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
      case "Stop":
        set("done");
        break;
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
        this.createTab(workspace.id, { cwd: tab.cwd, resumeClaudeSession: tab.claudeSessionId });
      }
      workspace.activeTabId = workspace.tabIds[savedWorkspace.activeTab] ?? workspace.tabIds[0] ?? null;
    }

    this.activeWorkspaceId = this.workspaces[saved.activeWorkspace]?.id ?? this.workspaces[0]?.id ?? null;
    this.emit("change");
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
  private resumeCommand(sessionId: string): string[] {
    const shell = this.command?.[0] ?? (process.env.SHELL || "/bin/zsh");
    return [shell, "-ilc", `${this.claudeCommand} --resume ${sessionId}; exec ${shell} -l`];
  }

  /** Ends every pane. For tests; the real daemon just exits. */
  killAll() {
    for (const pane of this.panes.values()) pane.kill();
  }

  private getTab(id: string): Tab {
    return {
      id,
      title: this.panes.get(id)?.displayTitle ?? "",
      cwd: this.cwds.get(id) ?? null,
      agent: this.agents.get(id) ?? null,
    };
  }

  private removeTab(tabId: string) {
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
