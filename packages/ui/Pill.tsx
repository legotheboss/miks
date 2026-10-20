import { colors, shadows } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { useEffect, useState } from "react";
import { styled } from "styled-components";

/** A word about something that just happened. A new `id` shows it again. */
export type Notice = { id: number; text: string };

/** How long a pill stays before it goes. */
const SHOWN_FOR = 1800;

/**
 * A notice in a pill, floating just above whatever it's placed in (which
 * must be positioned): in sight of what you're typing, not over it. It
 * rises in, stays a moment, and goes.
 */
export function Pill({ notice }: { notice: Notice | null }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const frame = requestAnimationFrame(() => setShown(true));
    const timer = setTimeout(() => setShown(false), SHOWN_FOR);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [notice?.id]);

  return (
    <StyledPill data-shown={shown} aria-live="polite">
      {notice?.text}
    </StyledPill>
  );
}

const StyledPill = styled.div`
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  z-index: 2;
  max-width: calc(100% - 24px);
  transform: translate(-50%, 6px);
  opacity: 0;
  transition:
    transform 0.2s ease-out,
    opacity 0.2s ease-out;
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

  &[data-shown="true"] {
    transform: translate(-50%, 0);
    opacity: 1;
  }
`;
