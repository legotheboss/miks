import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { Plus, X } from "lucide-react";
import { Workspace } from "miks/shared/protocol";
import { HTMLAttributes } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { tabTitle } from "./status";
import { StatusDot } from "./StatusDot";

export function TabBar({ workspace, ...rest }: HTMLAttributes<HTMLDivElement> & { workspace: Workspace }) {
  return (
    <StyledTabBar {...rest}>
      {workspace.tabs.map((tab) => (
        <div
          key={tab.id}
          className="tab"
          data-active={tab.id === workspace.activeTabId}
          onClick={() => daemon.send({ type: "select", workspaceId: workspace.id, tabId: tab.id })}
          onAuxClick={(event) => event.button === 1 && daemon.send({ type: "closeTab", tabId: tab.id })}
        >
          {tab.agent && <StatusDot status={tab.agent.status} />}
          <div className="title">{tabTitle(tab)}</div>
          <button
            className="close"
            title="Close tab (⌘W)"
            onClick={(event) => {
              event.stopPropagation();
              daemon.send({ type: "closeTab", tabId: tab.id });
            }}
          >
            <X />
          </button>
        </div>
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
  align-items: stretch;
  height: 38px;
  flex-shrink: 0;
  padding: 0 6px;
  gap: 2px;
  border-bottom: 1px solid ${colors.separator()};
  user-select: none;
  -webkit-app-region: drag;

  > .tab,
  > button {
    -webkit-app-region: no-drag;
  }

  > .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: 220px;
    margin: 6px 0;
    padding: 0 6px 0 10px;
    border-radius: 7px;
    cursor: default;
    color: ${colors.textSecondary()};

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
    }

    &[data-active="true"] {
      background: ${colors.linkActiveBackground()};
      color: ${colors.text()};
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
  }

  > .new-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    margin: 6px 0;
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
