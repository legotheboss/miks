import { colors, shadows } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { styled } from "styled-components";

/**
 * A word about something that just happened, in a pill that slides down
 * from the top of the window and back up: out of the way of what you're
 * typing, unlike a toast down where the composer is.
 */
let current: { id: number; text: string } | null = null;
const listeners = new Set<() => void>();

export function showPill(text: string) {
  current = { id: (current?.id ?? 0) + 1, text };
  for (const listener of listeners) listener();
}

/** How long a pill stays before it goes back up. */
const SHOWN_FOR = 1800;

export function PillHost() {
  const pill = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  const [shown, setShown] = useState(false);

  // In, a moment on screen, and out (a new pill starts it over).
  useEffect(() => {
    if (!pill) return;
    const frame = requestAnimationFrame(() => setShown(true));
    const timer = setTimeout(() => setShown(false), SHOWN_FOR);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [pill?.id]);

  return (
    <StyledPill data-shown={shown} aria-live="polite">
      {pill?.text}
    </StyledPill>
  );
}

const StyledPill = styled.div`
  position: fixed;
  top: 8px;
  left: 50%;
  z-index: 100;
  transform: translate(-50%, calc(-100% - 12px));
  transition: transform 0.25s ease-in-out;
  max-width: calc(100% - 200px);
  padding: 6px 14px;
  border-radius: 999px;
  background: ${colors.textBackground()};
  border: 1px solid ${colors.separator()};
  box-shadow: ${shadows.cardSmall()};
  color: ${colors.text()};
  font: ${fonts.displayMedium({ size: 12, line: "16px" })};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  -webkit-app-region: no-drag;

  &[data-shown="true"] {
    transform: translate(-50%, 0);
  }
`;
