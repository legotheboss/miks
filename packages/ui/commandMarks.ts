import type { IMarker, Terminal } from "@xterm/xterm";

type Prompt = { marker: IMarker; ran: boolean };

/**
 * Where each command is, from the shell's OSC 133 marks (Miks's zsh
 * integration sends them, packages/daemon/shell/zsh): a marker on each
 * prompt's first line, which xterm.js keeps on that line as it scrolls, and
 * whether a command ran from it.
 *
 * The marks live only in this terminal, so output from before the UI
 * attached (a reload, say) has none; `attached` makes the line you're on a
 * prompt, so at least the next command has one.
 */
export function trackCommands(terminal: Terminal) {
  let prompts: Prompt[] = [];
  const live = () => (prompts = prompts.filter((prompt) => !prompt.marker.isDisposed));

  const addPrompt = () => {
    const marker = terminal.registerMarker(0);
    if (marker) prompts.push({ marker, ran: false });
  };

  terminal.parser.registerOscHandler(133, (data) => {
    if (data.startsWith("A")) addPrompt();
    else if (data.startsWith("C") && prompts.length > 0) prompts[prompts.length - 1].ran = true;
    return true;
  });

  return {
    /**
     * Selects the last command that ran, from its prompt through its output,
     * for copying. Returns false if there's none to select.
     */
    selectLast(): boolean {
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal") return false;

      const all = live();
      for (let i = all.length - 1; i >= 0; i--) {
        if (!all[i].ran) continue;

        const start = all[i].marker.line;
        // Up to the next prompt, or (still running) the cursor.
        let end = i + 1 < all.length ? all[i + 1].marker.line - 1 : buffer.baseY + buffer.cursorY;
        while (end > start && !buffer.getLine(end)?.translateToString(true).trim()) end--;

        terminal.selectLines(start, end);
        if (start < buffer.viewportY) terminal.scrollToLine(start);
        return true;
      }
      return false;
    },

    /** After `terminal.clear()`, which keeps only the cursor's line. */
    cleared() {
      const all = live();
      // The prompt being typed at lost its marker if it was more than a line.
      if (all.length === 0 || all[all.length - 1].ran) addPrompt();
    },

    /** After a snapshot replaced everything: likely sitting at a prompt. */
    attached() {
      for (const prompt of prompts) prompt.marker.dispose();
      prompts = [];
      if (terminal.buffer.active.type === "normal") addPrompt();
    },
  };
}
