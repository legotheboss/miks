import { colors } from "crosswing/colors";
import { Button } from "crosswing/components/Button";
import { LabeledToggle } from "crosswing/components/forms/LabeledToggle";
import { TextInput } from "crosswing/components/forms/TextInput";
import { useInputValue } from "crosswing/components/forms/useInputValue";
import { SeparatorLayout, StyledSeparatorLayout } from "crosswing/components/SeparatorLayout";
import { TabbedButton, TabbedButtonLayout } from "crosswing/components/TabbedButtonLayout";
import { fonts } from "crosswing/fonts";
import { DialogView } from "crosswing/modals/dialog";
import { Plus, X } from "lucide-react";
import type { Remote } from "miks/shared/settings";
import { styled } from "styled-components";
import { useEffect, useState } from "react";
import { useTarget } from "./daemon";
import { updateSettings, useSettings } from "./settings";
import { focusActiveTerminal } from "./TerminalView";

export type SettingsTab = "general" | "remotes" | "advanced";

/**
 * Settings (⌘,). Changes apply as you make them, like the rest of macOS;
 * there's nothing to save.
 */
export function SettingsDialog({ initialTab = "general", onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // The terminal keeps the keyboard unless we take it: typing would land in
  // the shell behind the dialog, and Escape wouldn't close it. However it
  // closes (Escape, a click outside, the button), the keyboard goes back.
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return () => focusActiveTerminal();
  }, []);

  const target = useTarget();

  return (
    <DialogView title="Settings" onClose={onClose} form={false}>
      {/* This window is on another Mac, but its window, keys and notifications are this one's. */}
      {target && <StyledNote>Settings for this Mac. {target.name}'s are in Miks there.</StyledNote>}
      <StyledSettings layout="grow" pad={false} value={tab} onValueChange={setTab}>
        <TabbedButton title="General" value="general">
          <GeneralSettings />
        </TabbedButton>
        <TabbedButton title="Remotes" value="remotes">
          <RemoteSettings />
        </TabbedButton>
        <TabbedButton title="Advanced" value="advanced">
          <AdvancedSettings />
        </TabbedButton>
      </StyledSettings>
    </DialogView>
  );
}

function GeneralSettings() {
  const settings = useSettings();

  return (
    <SeparatorLayout bordered>
      <LabeledToggle
        label="Notifications"
        detail="When an agent finishes or needs you, unless you're looking at it."
        on={settings.notifications}
        onClick={() => updateSettings({ notifications: !settings.notifications })}
      />
      <LabeledToggle
        label="Claude Code status"
        detail="Adds hooks to ~/.claude/settings.json that tell Miks what Claude is up to. Outside Miks they do nothing."
        on={settings.claudeHooks}
        onClick={() => updateSettings({ claudeHooks: !settings.claudeHooks })}
      />
      <LabeledToggle
        label="Keep terminals running"
        detail="After Miks quits, so they're all still there when it opens again."
        on={settings.keepDaemonRunning}
        onClick={() => updateSettings({ keepDaemonRunning: !settings.keepDaemonRunning })}
      />
    </SeparatorLayout>
  );
}

function AdvancedSettings() {
  const settings = useSettings();
  const pathPrefix = useInputValue({
    initialValue: settings.hidePathPrefix || null,
    onValueChange: (_value, text) => updateSettings({ hidePathPrefix: text }),
  });

  return (
    <SeparatorLayout bordered>
      <LabeledToggle
        label="Option as Meta"
        detail="⌥ with a key sends Escape and the key, as shell shortcuts expect, instead of typing a character like å."
        on={settings.optionAsMeta}
        onClick={() => updateSettings({ optionAsMeta: !settings.optionAsMeta })}
      />
      {/* Laid out like the toggle above it, with the field where a switch is. */}
      <label className="field">
        <div className="content">
          <div className="label">Hide path prefix</div>
          <div className="detail">Left off directories in the sidebar, so ~/Code/sage shows as sage.</div>
        </div>
        <TextInput newStyle placeholder="~/Code/" {...pathPrefix.props} />
      </label>
    </SeparatorLayout>
  );
}

/** Badge colors, picked in turn for each Mac added, and by clicking the swatch. */
const REMOTE_COLORS = ["#3b82f6", "#e5734a", "#22a06b", "#9b5de5", "#d4a20b", "#e0567a"];

function RemoteSettings() {
  const { remotes } = useSettings();
  const setRemotes = (next: Remote[]) => updateSettings({ remotes: next });
  const change = (id: string, changes: Partial<Remote>) =>
    setRemotes(remotes.map((remote) => (remote.id === id ? { ...remote, ...changes } : remote)));

  const add = () =>
    setRemotes([
      ...remotes,
      {
        id: crypto.randomUUID().slice(0, 8),
        name: "",
        host: "",
        color: REMOTE_COLORS[remotes.length % REMOTE_COLORS.length],
      },
    ]);

  return (
    <StyledRemotes>
      <p className="intro">
        A window on another Mac's terminals, as if you were there. It connects over SSH, so <code>ssh host</code> has to
        work from here without a password, and that Mac needs Remote Login on and Miks running. Open one here, or from
        the Remotes menu (⌃⌥⌘1, ⌃⌥⌘2…).
      </p>
      {remotes.length > 0 && (
        <SeparatorLayout bordered>
          {remotes.map((remote) => (
            <div className="remote" key={remote.id}>
              <button
                className="swatch"
                style={{ background: remote.color }}
                title="Change color"
                onClick={() => {
                  const next = (REMOTE_COLORS.indexOf(remote.color) + 1) % REMOTE_COLORS.length;
                  change(remote.id, { color: REMOTE_COLORS[next] });
                }}
              />
              <TextInput
                newStyle
                className="name"
                placeholder="Name"
                value={remote.name}
                onValueChange={(name) => change(remote.id, { name })}
              />
              <TextInput
                newStyle
                className="host"
                placeholder="SSH host"
                value={remote.host}
                onValueChange={(host) => change(remote.id, { host })}
              />
              <Button newStyle
                className="open"
                disabled={!remote.name || !remote.host}
                onClick={() => window.miks?.openRemote(remote.id)}
                children="Open"
              />
              <button
                className="remove"
                title="Remove"
                onClick={() => setRemotes(remotes.filter((r) => r.id !== remote.id))}
              >
                <X />
              </button>
            </div>
          ))}
        </SeparatorLayout>
      )}
      <Button newStyle bordered className="add" icon={<Plus />} onClick={add} children="Add a Mac" />
    </StyledRemotes>
  );
}

const StyledRemotes = styled.div`
  display: flex;
  flex-flow: column;
  gap: 12px;

  > .intro {
    margin: 0;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13, line: "18px" })};

    > code {
      font-size: 12px;
    }
  }

  .remote {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;

    > .swatch {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 50%;
      cursor: pointer;
    }

    > .name {
      width: 110px;
      flex-shrink: 0;
    }

    > .host {
      flex-grow: 1;
      min-width: 0;
    }

    > .remove {
      display: flex;
      flex-shrink: 0;
      padding: 4px;
      border: none;
      background: transparent;
      color: ${colors.textSecondary()};
      cursor: pointer;

      > svg {
        width: 15px;
        height: 15px;
      }
    }
  }

  > .add {
    align-self: flex-start;
  }
`;

const StyledNote = styled.p`
  margin: 0 0 12px;
  color: ${colors.textSecondary()};
  font: ${fonts.display({ size: 13, line: "18px" })};
`;

const StyledSettings = styled(TabbedButtonLayout)`
  width: 520px;
  max-width: 100%;

  /* Each tab's content, clear of the tabs. */
  ${StyledRemotes}, ${StyledSeparatorLayout}:not(${StyledRemotes} *) {
    margin-top: 16px;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 20px;
    min-height: 50px;
    padding: 7px 10px;
    box-sizing: border-box;

    > .content {
      flex-grow: 1;
      display: flex;
      flex-flow: column;

      > .label {
        font: ${fonts.displayBold({ size: 14, line: "20px" })};
        color: ${colors.text()};
      }

      > .detail {
        font: ${fonts.display({ size: 14, line: "20px" })};
        color: ${colors.textSecondary()};
      }
    }

    > *:last-child {
      flex-shrink: 0;
      width: 130px;
    }
  }
`;
