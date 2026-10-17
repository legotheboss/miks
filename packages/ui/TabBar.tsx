import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { Plus, X } from "lucide-react";
import type { Tab, Workspace } from "miks/shared/protocol";
import { Fragment, HTMLAttributes } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { useDraggable } from "./draggable/useDraggable";
import { dropIndex } from "./Sidebar";
import { tabTitle } from "./status";
import { StatusDot } from "./StatusDot";

const DRAG_GROUP = "tabs";

export function TabBar({ workspace, ...rest }: HTMLAttributes<HTMLDivElement> & { workspace: Workspace }) {
  // Press and hold a tab to drag it along the bar.
  useDraggable({
    group: DRAG_GROUP,
    lockAxis: "x",
    onDrop: (tabId, target) => daemon.send({ type: "moveTab", tabId, index: dropIndex(workspace.tabs, tabId, target) }),
  });

  return (
    <StyledTabBar data-draggable-root {...rest}>
      <TabDropTarget data-draggable-target="top" data-draggable-group={DRAG_GROUP} />
      {workspace.tabs.map((tab) => (
        <Fragment key={tab.id}>
          <TabView tab={tab} workspaceId={workspace.id} active={tab.id === workspace.activeTabId} />
          <TabDropTarget
            data-draggable-target={`after:${tab.id}`}
            data-draggable-group={DRAG_GROUP}
            data-draggable-related-id={tab.id}
          />
        </Fragment>
      ))}
      <button
        className="new-tab"
        title="New tab (⌘T)"
        onClick={() => daemon.send({ type: "createTab", workspaceId: workspace.id })}
      >
        <Plus />
      </button>
      <div className="spacer" />
    </StyledTabBar>
  );
}

export const StyledTabBar = styled.div`
  display: flex;
  align-items: center;
  height: 38px;
  flex-shrink: 0;
  padding: 0 6px;
  border-bottom: 1px solid ${colors.separator()};
  user-select: none;
  -webkit-app-region: drag;

  > button {
    -webkit-app-region: no-drag;
  }

  > .new-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 26px;
    margin-left: 2px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: ${colors.textSecondary()};

    > svg {
      width: 15px;
      height: 15px;
    }

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
      color: ${colors.text()};
    }
  }

  > .spacer {
    flex-grow: 1;
  }
`;

function TabView({ tab, workspaceId, active }: { tab: Tab; workspaceId: string; active: boolean }) {
  return (
    <StyledTab
      data-draggable-id={tab.id}
      data-draggable-group={DRAG_GROUP}
      data-active={active}
      onClick={() => daemon.send({ type: "select", workspaceId, tabId: tab.id })}
      onAuxClick={(event) => event.button === 1 && daemon.send({ type: "closeTab", tabId: tab.id })}
    >
      {tab.agent && <StatusDot status={tab.agent.status} />}
      <div className="title">{tabTitle(tab)}</div>
      <button
        className="close"
        title="Close tab (⌘W)"
        // Not a drag: closing should work on a quick click.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          daemon.send({ type: "closeTab", tabId: tab.id });
        }}
      >
        <X />
      </button>
    </StyledTab>
  );
}

// Styled on its own, not from inside the bar: the copy that follows the
// pointer while dragging is put outside the bar, and must still look the part.
const StyledTab = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 1;
  gap: 7px;
  box-sizing: border-box;
  min-width: 0;
  max-width: 220px;
  height: 26px;
  padding: 0 6px 0 10px;
  border-radius: 7px;
  cursor: default;
  color: ${colors.textSecondary()};
  -webkit-app-region: no-drag;

  &:hover {
    background: ${colors.buttonBackgroundGlow()};
  }

  &[data-active="true"] {
    background: ${colors.linkActiveBackground()};
    color: ${colors.text()};
  }

  &[data-dragging="true"] {
    background: ${colors.textBackgroundPanel()};
    color: ${colors.text()};
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
  }

  > .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: ${fonts.display({ size: 12 })};
  }

  > .close {
    display: flex;
    padding: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    opacity: 0;

    > svg {
      width: 13px;
      height: 13px;
    }

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
    }
  }

  &:hover > .close,
  &[data-active="true"] > .close {
    opacity: 0.7;
  }
`;

const TabDropTarget = styled.div`
  flex-shrink: 0;
  align-self: center;
  width: var(--target-width, 2px);
  height: 26px;
  border-radius: 7px;
  -webkit-app-region: no-drag;

  &[data-draggable-hover="true"] {
    background: ${colors.buttonBackgroundGlow()};
  }
`;
