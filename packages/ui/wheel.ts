import type { Terminal } from "@xterm/xterm";

/**
 * Scrolling inside full-screen programs (Claude Code, vim, less) at the speed
 * the trackpad moves, the way Ghostty does it: one report per line's height
 * of scrolling. xterm.js sends at most one per wheel event, and scales
 * trackpad scrolling down to 0.3 besides, so a swipe there moves a few lines
 * where Ghostty moves dozens.
 *
 * Scrollback in the normal screen is left to xterm.js, which scrolls it
 * smoothly by the pixel.
 *
 * Returns what to call after `terminal.reset()`, which clears the encoding
 * without going through the parser.
 */
export function handleWheel(terminal: Terminal, send: (data: string) => void): { reset(): void } {
  // xterm.js keeps the mouse encoding to itself, so we watch for it too.
  let sgr = false;
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(1006)) sgr = true;
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(1006)) sgr = false;
    return false;
  });
  terminal.parser.registerEscHandler({ final: "c" }, () => {
    sgr = false;
    return false;
  });

  // Fractions of a line carried over to the next event.
  let partial = 0;

  terminal.attachCustomWheelEventHandler((event) => {
    const tracking = terminal.modes.mouseTrackingMode !== "none";
    const alternate = terminal.buffer.active.type === "alternate";
    if (event.deltaY === 0 || event.shiftKey || (!tracking && !alternate)) return true;

    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!screen) return true;
    const rect = screen.getBoundingClientRect();
    const cellHeight = rect.height / terminal.rows;

    const lines =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * terminal.rows
          : event.deltaY / cellHeight;
    partial += lines;
    // A change of direction starts over, so the first line back isn't eaten.
    if (Math.sign(partial) !== Math.sign(lines)) partial = lines;

    const count = Math.min(Math.trunc(Math.abs(partial)), terminal.rows);
    partial -= Math.trunc(partial);
    if (count === 0) return false;

    const up = event.deltaY < 0;
    let report: string;
    if (tracking) {
      const col = clamp(Math.floor((event.clientX - rect.left) / (rect.width / terminal.cols)) + 1, 1, terminal.cols);
      const row = clamp(Math.floor((event.clientY - rect.top) / cellHeight) + 1, 1, terminal.rows);
      // Wheel up and down are buttons 64 and 65.
      const button = up ? 64 : 65;
      report = sgr
        ? `\x1b[<${button};${col};${row}M`
        : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`;
    } else {
      // Without mouse reporting, a program on the alternate screen gets arrow
      // keys, as in xterm.js and Terminal.app.
      report = `\x1b${terminal.modes.applicationCursorKeysMode ? "O" : "["}${up ? "A" : "B"}`;
    }

    send(report.repeat(count));
    return false;
  });

  return { reset: () => (sgr = false) };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
