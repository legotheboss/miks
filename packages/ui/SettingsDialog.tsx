import { colors } from "crosswing/colors";
import { LabeledTextInput } from "crosswing/components/forms/LabeledTextInput";
import { LabeledToggle } from "crosswing/components/forms/LabeledToggle";
import { useInputValue } from "crosswing/components/forms/useInputValue";
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
      <StyledSettings>
        <LabeledTextInput label="Hide path prefix" placeholder="~/Code/" {...pathPrefix.props} />
        <div className="hint">Left off directories in the sidebar, so ~/Code/sage shows as sage.</div>
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

const StyledSettings = styled.div`
  display: flex;
  flex-flow: column;
  gap: 10px;
  width: 440px;
  max-width: 100%;

  > .hint {
    /* Lined up with the field's label. */
    margin-top: -4px;
    padding: 0 10px;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 12 })};
  }
`;
