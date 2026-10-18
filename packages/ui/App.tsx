import { colors } from "crosswing/colors";
import { PanelLayout } from "crosswing/components/PanelLayout";
import { fonts } from "crosswing/fonts";
import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { useDialog } from "crosswing/modals/dialog";
import type { AgentStatus, DaemonState } from "miks/shared/protocol";
import { DEFAULT_SETTINGS } from "miks/shared/settings";
import { useEffect, useRef } from "react";
import { styled } from "styled-components";
import { daemon, useDaemon } from "./daemon";
import { getSettings, setFontSize, updateSettings, useSettings } from "./settings";
import { Sidebar } from "./Sidebar";
import { workspaceTitle } from "./status";
import { StyledTabBar, TabBar } from "./TabBar";
import { SettingsDialog } from "./SettingsDialog";
import { clearActiveTerminal, selectLastCommand, TERMINAL_BACKGROUND, TerminalView } from "./TerminalView";

export function App() {
  const { state, connected, error } = useDaemon();
  const { sidebarVisible } = useSettings();

  const settingsDialog = useDialog(() => <SettingsDialog onClose={settingsDialog.hide} />);

  useEffect(() => {
    const handle = (command: string) => (command === "settings" ? settingsDialog.show() : runCommand(command));

    // In development, `window.miksCommand("newTab")` runs a menu command, for
    // checking them from DevTools (menu shortcuts can't be sent from there).
    if (import.meta.env.DEV) (window as any).miksCommand = handle;

    return daemon.onCommand(handle);
  }, [settingsDialog]);
  useSeenTracking(state);
  useAppearanceReporting(connected);
  useAgentNotifications(state);

  if (!connected || !state) {
    return (
      <StyledApp>
        <div className="message">
          <div className="titlebar" />
          <p>{error ?? "Connecting to the daemon…"}</p>
          {error && <button onClick={() => daemon.reconnect()}>Start the daemon</button>}
        </div>
      </StyledApp>
    );
  }

  const activeWorkspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;

  return (
    <StyledApp>
      <PanelLayout
        className="layout"
        edge="left"
        // Always beside the terminals, never over them.
        mode="shrink"
        panelVisible={sidebarVisible}
        onPanelVisibleChange={(visible) => updateSettings({ sidebarVisible: visible })}
        panelDefaultSize={230}
        // Room for the traffic lights, which sit over the sidebar's top.
        panelMinSize={180}
        panelMaxSize={480}
        contentMinSize={320}
        // ⌘B is a menu item; a hotkey here would never see it past the terminal.
        hotkey={null}
        hideToolbarButton
        hideDragHandle
        restorationKey={Sidebar}
      >
        <div className="main" data-sidebar-visible={sidebarVisible}>
          {activeWorkspace ? <TabBar workspace={activeWorkspace} /> : <div className="empty-bar" />}
          <div className="terminals">
            {/* Every tab's terminal stays mounted, so switching is instant. */}
            {state.workspaces.flatMap((workspace) =>
              workspace.tabs.map((tab) => (
                <TerminalView
                  key={tab.id}
                  tabId={tab.id}
                  active={workspace.id === state.activeWorkspaceId && tab.id === workspace.activeTabId}
                />
              )),
            )}
            {!activeWorkspace && (
              <div className="empty">
                <button onClick={() => daemon.send({ type: "createWorkspace" })}>New workspace</button>
              </div>
            )}
          </div>
        </div>
        <Sidebar workspaces={state.workspaces} activeWorkspaceId={state.activeWorkspaceId} home={state.home} />
      </PanelLayout>
    </StyledApp>
  );
}

export const StyledApp = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  background: ${colors.textBackground()};
  color: ${colors.text()};
  font: ${fonts.display({ size: 13 })};

  > .layout {
    flex-grow: 1;
    min-width: 0;
  }

  .main {
    display: flex;
    flex-flow: column;

    /* With the sidebar hidden, the traffic lights sit over the tab bar. */
    &[data-sidebar-visible="false"] > ${StyledTabBar}, &[data-sidebar-visible="false"] > .empty-bar {
      padding-left: 80px;
    }

    > .empty-bar {
      height: 38px;
      -webkit-app-region: drag;
    }

    > .terminals {
      flex-grow: 1;
      position: relative;
      overflow: hidden;
      /* Matches the terminal themes, so the padding around them blends in. */
      background: ${TERMINAL_BACKGROUND.light};

      @media (prefers-color-scheme: dark) {
        background: ${TERMINAL_BACKGROUND.dark};
      }

      > .empty {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    }
  }

  > .message {
    flex-grow: 1;
    display: flex;
    flex-flow: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: ${colors.textSecondary()};

    > .titlebar {
      position: absolute;
      inset: 0 0 auto 0;
      height: 44px;
      -webkit-app-region: drag;
    }
  }

  button {
    font: inherit;
  }
`;

/**
 * Menu commands. They read the state fresh each time, so the handler never
 * has to be resubscribed.
 */
function runCommand(command: string) {
  switch (command) {
    case "toggleSidebar":
      return updateSettings({ sidebarVisible: !getSettings().sidebarVisible });
    case "fontBigger":
      return setFontSize(getSettings().fontSize + 1);
    case "fontSmaller":
      return setFontSize(getSettings().fontSize - 1);
    case "fontReset":
      return setFontSize(DEFAULT_SETTINGS.fontSize);
    case "selectLastCommand":
      return selectLastCommand();
    case "clearToStart":
      return clearActiveTerminal();
  }

  const state = daemon.getSnapshot().state;
  if (!state) return;

  const workspaces = state.workspaces;
  const workspace = workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tabs = workspace?.tabs ?? [];
  const tabIndex = tabs.findIndex((tab) => tab.id === workspace?.activeTabId);
  const workspaceIndex = workspaces.findIndex((w) => w.id === workspace?.id);

  const selectTab = (offset: number) => {
    if (!workspace || tabs.length === 0) return;
    const tab = tabs[(tabIndex + offset + tabs.length) % tabs.length];
    daemon.send({ type: "select", workspaceId: workspace.id, tabId: tab.id });
  };

  const selectWorkspace = (index: number) => {
    const target = workspaces[index];
    if (target) daemon.send({ type: "select", workspaceId: target.id });
  };

  switch (command) {
    case "newTab":
      if (workspace) daemon.send({ type: "createTab", workspaceId: workspace.id });
      else daemon.send({ type: "createWorkspace" });
      return;
    case "newWorkspace":
      return daemon.send({ type: "createWorkspace" });
    case "closeTab":
      if (workspace?.activeTabId) daemon.send({ type: "closeTab", tabId: workspace.activeTabId });
      return;
    case "closeWorkspace":
      if (workspace) daemon.send({ type: "closeWorkspace", workspaceId: workspace.id });
      return;
    case "nextTab":
      return selectTab(1);
    case "previousTab":
      return selectTab(-1);
    case "nextWorkspace":
      return selectWorkspace((workspaceIndex + 1) % workspaces.length);
    case "previousWorkspace":
      return selectWorkspace((workspaceIndex - 1 + workspaces.length) % workspaces.length);
  }

  const number = command.match(/^workspace(\d)$/)?.[1];
  if (number) selectWorkspace(Number(number) - 1);
}

/**
 * An agent's `done` means "finished, and you haven't looked yet". Selecting
 * the tab clears it in the daemon; this covers the other way of looking: the
 * tab was already on screen, in a focused window, when the agent finished.
 */
function useSeenTracking(state: DaemonState | null) {
  const workspace = state?.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tab = workspace?.tabs.find((t) => t.id === workspace.activeTabId);
  const doneTabId = tab?.agent?.status === "done" ? tab.id : null;

  useEffect(() => {
    if (!doneTabId) return;

    const markSeen = () => daemon.send({ type: "seen", tabId: doneTabId });
    if (document.hasFocus()) markSeen();

    window.addEventListener("focus", markSeen);
    return () => window.removeEventListener("focus", markSeen);
  }, [doneTabId]);
}

/**
 * Tells the daemon whether we're light or dark, now and whenever it changes,
 * so programs that follow the terminal's color scheme (Claude Code, set to its
 * "auto" theme) switch with the system.
 */
function useAppearanceReporting(connected: boolean) {
  const dark = useMatchMedia("(prefers-color-scheme: dark)");

  useEffect(() => {
    if (connected) daemon.send({ type: "appearance", dark });
  }, [connected, dark]);
}

/**
 * A notification when an agent finishes or needs you, unless you're already
 * looking at it. Only for changes seen while connected: the statuses a fresh
 * connection reports are old news.
 */
function useAgentNotifications(state: DaemonState | null) {
  const { notifications } = useSettings();
  const previous = useRef<Map<string, AgentStatus | undefined> | null>(null);

  useEffect(() => {
    if (!state) return;

    const statuses = new Map<string, AgentStatus | undefined>();
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) statuses.set(tab.id, tab.agent?.status);
    }

    const before = previous.current;
    previous.current = statuses;
    if (!before || !notifications) return;

    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        const status = tab.agent?.status;
        if (status !== "done" && status !== "waiting") continue;
        if (!before.has(tab.id) || before.get(tab.id) === status) continue;

        const onScreen = workspace.id === state.activeWorkspaceId && tab.id === workspace.activeTabId;
        if (onScreen && document.hasFocus()) continue;

        const notification = new Notification(workspaceTitle(workspace), {
          body: status === "waiting" ? (tab.agent?.message ?? "Needs your input") : "Done",
          // One per tab: a newer status replaces an older one still showing.
          tag: tab.id,
        });
        notification.onclick = () => {
          window.miks?.focus();
          daemon.send({ type: "select", workspaceId: workspace.id, tabId: tab.id });
        };
      }
    }
  }, [state, notifications]);
}
