import { AgentStatus } from "miks/shared/protocol";
import { HTMLAttributes } from "react";
import { styled } from "styled-components";
import { statusColors } from "./status";

export function StatusDot({ status, ...rest }: HTMLAttributes<HTMLDivElement> & { status: AgentStatus }) {
  return <StyledStatusDot data-status={status} {...rest} />;
}

export const StyledStatusDot = styled.div`
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;

  &[data-status="waiting"] {
    background: ${statusColors.waiting};
    box-shadow: 0 0 0 3px color-mix(in srgb, ${statusColors.waiting} 30%, transparent);
  }

  &[data-status="done"] {
    background: ${statusColors.done};
  }

  &[data-status="working"] {
    background: ${statusColors.working};
    animation: miks-pulse 1.2s ease-in-out infinite;
  }

  &[data-status="idle"] {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px ${statusColors.idle};
  }

  @keyframes miks-pulse {
    50% {
      opacity: 0.35;
    }
  }
`;
