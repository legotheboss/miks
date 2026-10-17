import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { Plus } from "lucide-react";
import { Workspace } from "miks/shared/protocol";
import { HTMLAttributes, KeyboardEvent, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { STATUS_LABELS, waitingMessage, workspaceStatus, workspaceTitle } from "./status";
import { StatusDot } from "./StatusDot";

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}) {
  return (
    <StyledSidebar {...rest}>
      <div className="titlebar" />
      <div className="workspaces">
        {workspaces.map((workspace, index) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            shortcut={index < 9 ? `⌘${index + 1}` : undefined}
            selected={workspace.id === activeWorkspaceId}
          />
        ))}
      </div>
      <button className="new-workspace" onClick={() => daemon.send({ type: "createWorkspace" })}>
        <Plus />
        <span>New workspace</span>
      </button>
    </StyledSidebar>
  );
}

export const StyledSidebar = styled.div`
  display: flex;
  flex-flow: column;
  background: ${colors.textBackgroundPanel()};
  border-right: 1px solid ${colors.separator()};
  user-select: none;

  > .titlebar {
    /* Room for the traffic lights, and something to drag the window by. */
    flex-shrink: 0;
    height: 44px;
    -webkit-app-region: drag;
  }

  > .workspaces {
    flex-grow: 1;
    overflow-y: auto;
    display: flex;
    flex-flow: column;
    gap: 2px;
    padding: 0 8px;
  }

  > .new-workspace {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13 })};
    cursor: pointer;

    > svg {
      width: 16px;
      height: 16px;
    }

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
      color: ${colors.text()};
    }
  }
`;

function WorkspaceRow({
  workspace,
  shortcut,
  selected,
}: {
  workspace: Workspace;
  shortcut?: string;
  selected: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const status = workspaceStatus(workspace);
  const message = status === "waiting" ? waitingMessage(workspace) : null;
  const title = workspaceTitle(workspace);

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      daemon.send({ type: "renameWorkspace", workspaceId: workspace.id, title: event.currentTarget.value });
      setRenaming(false);
    } else if (event.key === "Escape") {
      setRenaming(false);
    }
  }

  return (
    <StyledWorkspaceRow
      data-selected={selected}
      data-status={status ?? undefined}
      onClick={() => daemon.send({ type: "select", workspaceId: workspace.id })}
      onDoubleClick={() => setRenaming(true)}
      title="Double-click to rename"
    >
      <div className="top">
        {renaming ? (
          <input
            autoFocus
            defaultValue={workspace.title ?? ""}
            placeholder={title}
            onKeyDown={onRenameKeyDown}
            onBlur={() => setRenaming(false)}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <div className="title">{title}</div>
        )}
        {shortcut && !renaming && <div className="shortcut">{shortcut}</div>}
      </div>
      <div className="bottom">
        {status && <StatusDot status={status} />}
        <div className="detail">
          {message ?? (status ? STATUS_LABELS[status] : plural(workspace.tabs.length, "tab"))}
        </div>
      </div>
    </StyledWorkspaceRow>
  );
}

const StyledWorkspaceRow = styled.div`
  display: flex;
  flex-flow: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: default;

  &:hover {
    background: ${colors.buttonBackgroundGlow()};
  }

  &[data-selected="true"] {
    background: ${colors.linkActiveBackground()};
  }

  > .top {
    display: flex;
    align-items: center;
    gap: 8px;

    > .title {
      flex-grow: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${colors.text()};
      font: ${fonts.displayMedium({ size: 13 })};
    }

    > input {
      flex-grow: 1;
      min-width: 0;
      padding: 0 4px;
      margin: -1px -5px;
      border: 1px solid ${colors.primary()};
      border-radius: 4px;
      outline: none;
      background: ${colors.textBackground()};
      color: ${colors.text()};
      font: ${fonts.displayMedium({ size: 13 })};
    }

    > .shortcut {
      flex-shrink: 0;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 11 })};
      opacity: 0.7;
    }
  }

  > .bottom {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 16px;

    > .detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12 })};
    }
  }

  &[data-status="waiting"] > .bottom > .detail {
    color: ${colors.orange()};
  }
`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
