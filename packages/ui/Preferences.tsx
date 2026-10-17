import { colors } from "crosswing/colors";
import { LabeledTextInput } from "crosswing/components/forms/LabeledTextInput";
import { LabeledToggle } from "crosswing/components/forms/LabeledToggle";
import { useInputValue } from "crosswing/components/forms/useInputValue";
import { fonts } from "crosswing/fonts";
import { styled } from "styled-components";
import { updateSettings, useSettings } from "./settings";

/**
 * The Settings window (⌘,). Changes apply as you make them, like the rest of
 * macOS; there's nothing to save.
 */
export function Preferences() {
  const settings = useSettings();

  const pathPrefix = useInputValue({
    initialValue: settings.hidePathPrefix || null,
    onValueChange: (_value, text) => updateSettings({ hidePathPrefix: text }),
  });

  return (
    <StyledPreferences>
      <div className="fields">
        <LabeledTextInput label="Hide path prefix" placeholder="~/Code/" {...pathPrefix.props} />
        <div className="hint">Left off directories in the sidebar, so ~/Code/sage shows as sage.</div>
        <LabeledToggle
          label="Notifications"
          detail="When an agent finishes or needs you, unless you're looking at it."
          on={settings.notifications}
          onClick={() => updateSettings({ notifications: !settings.notifications })}
        />
      </div>
    </StyledPreferences>
  );
}

export const StyledPreferences = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  flex-flow: column;
  background: ${colors.textBackground()};
  color: ${colors.text()};
  user-select: none;

  > .fields {
    display: flex;
    flex-flow: column;
    gap: 10px;
    padding: 16px 20px 20px;

    > .hint {
      /* Lined up with the field's label. */
      margin-top: -4px;
      padding: 0 10px;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12 })};
    }
  }
`;
