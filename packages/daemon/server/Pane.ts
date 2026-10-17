import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { execFile } from "child_process";
import { EventEmitter } from "events";
import * as pty from "node-pty";
import path from "path";

const { Terminal } = headless;

const SCROLLBACK = 10_000;

/** Someone watching a pane: in practice, one UI connection. */
export type PaneViewer = {
  /** The screen as VT sequences, at the pane's size. */
  snapshot(data: string, cols: number, rows: number): void;
  output(data: string): void;
};

/**
 * Variables we must not pass down from whatever launched the daemon. When the
 * UI is started from inside another terminal (cmux, Ghostty, Claude Code
 * itself), these would make programs in our panes think they're running
 * there instead: cmux's hooks would report to cmux, and `claude` would refuse
 * to start inside "another" Claude Code session.
 */
const INHERITED_ENV_BLOCKLIST = [
  /^CMUX_/,
  /^GHOSTTY_/,
  /^TERM_PROGRAM/,
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_ENTRYPOINT$/,
  // Miks's own: each pane sets its own MIKS_PANE_ID and MIKS_SOCKET, and the
  // dev build's MIKS_UI_URL would point any Miks.app launched from a pane at
  // the dev server.
  /^MIKS_/,
  // The daemon runs as Miks.app's binary in Node mode; a shell inheriting
  // this would make every Electron app it launched (VS Code's `code`, say)
  // start as plain Node instead.
  /^ELECTRON_/,
];

/**
 * One shell in a PTY, plus a headless terminal emulator that sees every byte
 * it prints. The emulator is what makes reattaching work: a new viewer gets
 * the emulator's current screen serialized as VT sequences, then the live
 * stream from exactly that point on.
 *
 * Only viewers answer terminal queries (cursor position, device attributes):
 * the headless emulator's replies are dropped, the same way VS Code's pty
 * host does it, so each query gets exactly one answer while a UI is attached.
 */
export class Pane extends EventEmitter<{
  /** The new title, then the one it replaced. */
  title: [string, string];
  exit: [number];
}> {
  readonly id: string;
  title: string;
  /** Whether the program asked to hear about color scheme changes (DEC mode 2031). */
  private reportsColorScheme = false;
  private dark = true;

  private readonly pty: pty.IPty;
  private readonly terminal: InstanceType<typeof Terminal>;
  private readonly serializer = new SerializeAddon();
  private readonly viewers = new Set<PaneViewer>();
  /** Viewers whose snapshot is being taken, and the output they'll need after it. */
  private readonly attaching = new Map<PaneViewer, string[]>();

  constructor({
    id,
    cwd,
    env,
    command = [process.env.SHELL || "/bin/zsh", "-l"],
    dark = true,
    cols = 80,
    rows = 24,
  }: {
    id: string;
    cwd: string;
    env: Record<string, string>;
    /** What to run; a login shell unless told otherwise (tests are). */
    command?: string[];
    /** Whether the UI is in dark mode, for color scheme reports. */
    dark?: boolean;
    cols?: number;
    rows?: number;
  }) {
    super();
    this.id = id;
    this.dark = dark;

    const [file, ...args] = command;
    this.title = path.basename(file);

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer as any);
    // Color scheme reporting, which xterm.js doesn't do itself. Programs like
    // Claude Code switch between their light and dark themes with it: they
    // set mode 2031 to be told when the scheme changes, and ask with CSI ? 996 n.
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(2031) && !this.reportsColorScheme) {
        this.reportsColorScheme = true;
        // Say where things stand now, not just when they change: Claude Code
        // turns this on at startup and never asks.
        this.reportColorScheme();
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(2031)) this.reportsColorScheme = false;
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params[0] !== 996) return false;
      this.reportColorScheme();
      return true;
    });

    this.terminal.onTitleChange((title) => {
      const previous = this.title;
      this.title = title;
      this.emit("title", title, previous);
    });

    this.pty = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...paneEnv(), ...env },
    });

    this.pty.onData((data) => {
      this.terminal.write(data);
      for (const viewer of this.viewers) viewer.output(data);
      for (const pending of this.attaching.values()) pending.push(data);
    });

    this.pty.onExit(({ exitCode }) => {
      this.viewers.clear();
      this.attaching.clear();
      this.terminal.dispose();
      this.emit("exit", exitCode);
    });
  }

  /** Without a size, the pane keeps its own and the viewer adopts it. */
  attach(viewer: PaneViewer, size?: { cols: number; rows: number }) {
    this.detach(viewer);
    if (size) this.resize(size.cols, size.rows);

    // The emulator parses writes asynchronously, so the snapshot has to wait
    // until it has caught up with everything written so far. An empty write's
    // callback fires right after the bytes queued ahead of it are parsed.
    // Anything the PTY prints in the meantime is held for this viewer, since
    // it'll be missing from the snapshot.
    this.attaching.set(viewer, []);
    this.terminal.write("", () => {
      const pending = this.attaching.get(viewer);
      if (!pending) return; // Detached (or exited) while we waited.

      this.attaching.delete(viewer);
      viewer.snapshot(this.serializer.serialize({ scrollback: SCROLLBACK }), this.terminal.cols, this.terminal.rows);
      for (const data of pending) viewer.output(data);
      this.viewers.add(viewer);
    });
  }

  detach(viewer: PaneViewer) {
    this.viewers.delete(viewer);
    this.attaching.delete(viewer);
  }

  write(data: string) {
    this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    cols = Math.max(2, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;

    this.terminal.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  kill() {
    this.pty.kill("SIGHUP");
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Follows the UI's light or dark appearance, telling the program if it asked. */
  setDark(dark: boolean) {
    if (dark === this.dark) return;
    this.dark = dark;
    if (this.reportsColorScheme) this.reportColorScheme();
  }

  private reportColorScheme() {
    this.pty.write(`\x1b[?997;${this.dark ? 1 : 2}n`);
  }

  /** The shell's working directory, or null if it can't be read. */
  cwd(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("lsof", ["-a", "-p", String(this.pty.pid), "-d", "cwd", "-Fn"], (error, stdout) => {
        const line = stdout?.split("\n").find((l) => l.startsWith("n"));
        resolve(!error && line ? line.slice(1) : null);
      });
    });
  }
}

function paneEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (INHERITED_ENV_BLOCKLIST.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }

  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Miks",
  };
}
