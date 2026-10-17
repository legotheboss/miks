import { colors } from "crosswing/colors";
import { LabeledToggle } from "crosswing/components/forms/LabeledToggle";
import { TextInput } from "crosswing/components/forms/TextInput";
import { useInputValue } from "crosswing/components/forms/useInputValue";
import { SeparatorLayout } from "crosswing/components/SeparatorLayout";
import { fonts } from "crosswing/fonts";
import { DialogView } from "crosswing/modals/dialog";
import { styled } from "styled-components";
import { useEffect } from "react";
import { updateSettings, useSettings } from "./settings";
import { focusActiveTerminal } from "./TerminalView";

/**
 * Settings (⌘,). Changes apply as you make them, like the rest of macOS;
 * there's nothing to save.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettings();

  // The terminal keeps the keyboard unless we take it: typing would land in
  // the shell behind the dialog, and Escape wouldn't close it. However it
  // closes (Escape, a click outside, the button), the keyboard goes back.
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return () => focusActiveTerminal();
  }, []);

  const pathPrefix = useInputValue({
    initialValue: settings.hidePathPrefix || null,
    onValueChange: (_value, text) => updateSettings({ hidePathPrefix: text }),
  });

  return (
    <DialogView title="Settings" onClose={onClose} form={false}>
      <StyledSettings bordered>
        {/* Laid out like the toggle below it, with the field where its switch is. */}
        <label className="field">
          <div className="content">
            <div className="label">Hide path prefix</div>
            <div className="detail">Left off directories in the sidebar, so ~/Code/sage shows as sage.</div>
          </div>
          <TextInput newStyle placeholder="~/Code/" {...pathPrefix.props} />
        </label>
        <LabeledToggle
          label="Notifications"
          detail="When an agent finishes or needs you, unless you're looking at it."
          on={settings.notifications}
          onClick={() => updateSettings({ notifications: !settings.notifications })}
        />
      </StyledSettings>
    </DialogView>
  );
}

const StyledSettings = styled(SeparatorLayout)`
  width: 440px;
  max-width: 100%;

  > .field {
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
