import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import os from "os";
import type { AgentState, DaemonState, Tab } from "../shared/protocol.ts";
import { Pane } from "./Pane.ts";

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

  private readonly socketPath: string;
  private readonly command?: string[];

  constructor({ socketPath, command }: { socketPath: string; command?: string[] }) {
    super();
    this.socketPath = socketPath;
    this.command = command;
  }

  getState(): DaemonState {
    return {
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

  createTab(workspaceId: string): string | undefined {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    const id = shortId();
    const pane = new Pane({
      id,
      cwd: workspace.cwd,
      command: this.command,
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

  /** Ends every pane. For tests; the real daemon just exits. */
  killAll() {
    for (const pane of this.panes.values()) pane.kill();
  }

  private getTab(id: string): Tab {
    return {
      id,
      title: this.panes.get(id)?.title ?? "",
      agent: this.agents.get(id) ?? null,
    };
  }

  private removeTab(tabId: string) {
    this.panes.delete(tabId);
    this.agents.delete(tabId);

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

function shortId(): string {
  return randomUUID().slice(0, 8);
}
