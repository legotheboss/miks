import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { DragEvent, HTMLAttributes, useEffect, useRef } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { getSettings, useSettings } from "./settings";
import { trackCommands } from "./commandMarks";
import { handleWheel } from "./wheel";

/**
 * One pane's terminal. Every tab's terminal stays mounted (stacked, with only
 * the active one visible) so each keeps its size, scrollback, and stream; the
 * daemon owns the real state, so this is a view that can be rebuilt anytime.
 */
export function TerminalView({
  tabId,
  active,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  tabId: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const dark = useMatchMedia("(prefers-color-scheme: dark)");
  const { fontSize, optionAsMeta } = useSettings();

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: `"SF Mono", Menlo, Monaco, monospace`,
      fontSize: getSettings().fontSize,
      lineHeight: 1.15,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: getSettings().optionAsMeta,
      theme: dark ? darkTheme : lightTheme,
    });
    const fit = new FitAddon();
    const commands = trackCommands(terminal);
    viewRef.current = { tabId, terminal, fit, commands };

    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    // window.open is routed to the real browser by the app.
    terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    terminal.open(containerRef.current!);
    const wheel = handleWheel(terminal, (data) => daemon.send({ type: "input", tabId, data }));

    const unstream = daemon.stream(tabId, (event) => {
      if (event.type === "snapshot") {
        terminal.reset();
        wheel.reset();
        // A tab that isn't on screen takes the pane's size as it is.
        if (event.cols !== terminal.cols || event.rows !== terminal.rows) {
          terminal.resize(event.cols, event.rows);
        }
      }
      // Once it's parsed, where the cursor is: the snapshot carries no marks.
      if (event.type === "snapshot") terminal.write(event.data, () => commands.attached());
      else terminal.write(event.data);
    });

    // Only the tab on screen decides its pane's size, and only once its
    // renderer is in place: the WebGL and DOM renderers measure characters
    // differently, and every size change is a SIGWINCH that makes full-screen
    // programs redraw.
    const attach = () => {
      if (activeRef.current) daemon.send({ type: "attach", tabId, cols: terminal.cols, rows: terminal.rows });
      else daemon.send({ type: "attach", tabId });
    };
    const unconnect = daemon.onConnect(attach);

    const input = terminal.onData((data) => daemon.send({ type: "input", tabId, data }));
    const binary = terminal.onBinary((data) => daemon.send({ type: "input", tabId, data }));

    if (activeRef.current) prepareActive(terminal, fit);
    if (daemon.connected) attach();

    // Adopting the pane's size from a snapshot echoes it back here too, which
    // the daemon ignores since nothing changed.
    // The daemon hears about a new size once it settles. Dragging the sidebar
    // or the window edge refits on every frame, and each size the pane takes
    // is a SIGWINCH that makes Claude Code or vim redraw.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resize = terminal.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => daemon.send({ type: "resize", tabId, cols, rows }), 100);
    });

    const observer = new ResizeObserver(() => {
      if (activeRef.current) fit.fit();
    });
    observer.observe(containerRef.current!);

    return () => {
      observer.disconnect();
      input.dispose();
      binary.dispose();
      resize.dispose();
      if (resizeTimer) clearTimeout(resizeTimer);
      unconnect();
      unstream();
      daemon.send({ type: "detach", tabId });
      webglAddons.get(terminal)?.dispose();
      terminal.dispose();
      viewRef.current = null;
    };
    // The theme is applied below, without rebuilding the terminal.
  }, [tabId]);

  useEffect(() => {
    if (viewRef.current) viewRef.current.terminal.options.theme = dark ? darkTheme : lightTheme;
  }, [dark]);

  useEffect(() => {
    if (viewRef.current) viewRef.current.terminal.options.macOptionIsMeta = optionAsMeta;
  }, [optionAsMeta]);

  // A new font size changes how many cells fit, so the visible terminal
  // refits (resizing its pane); hidden ones refit when they come on screen.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.terminal.options.fontSize === fontSize) return;

    view.terminal.options.fontSize = fontSize;
    if (activeRef.current) view.fit.fit();
  }, [fontSize]);

  // Coming on screen: switch to WebGL and fit to the area, which resizes the
  // pane only if the area actually changed while the tab was hidden.
  useEffect(() => {
    const view = viewRef.current;
    if (!active || !view) return;

    prepareActive(view.terminal, view.fit);
    view.terminal.focus();
    activeView = view;

    return () => {
      if (activeView === view) activeView = null;
      webglAddons.get(view.terminal)?.dispose();
      webglAddons.delete(view.terminal);
    };
  }, [active]);

  // Dropping files types their paths, escaped the way Terminal.app does it,
  // which is also how Claude Code recognizes a dropped image.
  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const paths = files.map((file) => window.miks?.pathForFile(file)).filter(Boolean) as string[];
    if (paths.length === 0) return;

    viewRef.current?.terminal.paste(paths.map(shellEscape).join(" ") + " ");
    viewRef.current?.terminal.focus();
  }

  return (
    <StyledTerminalView
      ref={containerRef}
      data-active={active}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      {...rest}
    />
  );
}

function shellEscape(path: string): string {
  // Only ASCII characters the shell treats specially; "é" stays as it is.
  return path.replace(/[\s!"#$&'()*;<>?[\\\]^`{|}~]/g, "\\$&");
}

type View = { tabId: string; terminal: Terminal; fit: FitAddon; commands: ReturnType<typeof trackCommands> };

let activeView: View | null = null;

/** Gives the keyboard back to the terminal on screen (after a dialog, say). */
export function focusActiveTerminal() {
  activeView?.terminal.focus();
}

/** Edit → Select last command (⌘⇧A): its prompt through its output. */
export function selectLastCommand() {
  activeView?.commands.selectLast();
}

/**
 * Edit → Clear to start (⌘K), as in Terminal.app: the screen and scrollback,
 * all but the line you're typing on. Not in full-screen programs, which own
 * their screen.
 */
export function clearActiveTerminal() {
  const view = activeView;
  if (!view || view.terminal.buffer.active.type !== "normal") return;
  view.terminal.clear();
  view.commands.cleared();
  daemon.send({ type: "clear", tabId: view.tabId });
}

/**
 * Only the visible terminal gets a WebGL renderer: Chromium caps how many
 * WebGL contexts a page can have, and hidden terminals don't need one.
 */
const webglAddons = new WeakMap<Terminal, WebglAddon>();

function prepareActive(terminal: Terminal, fit: FitAddon) {
  if (!webglAddons.has(terminal)) {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      webglAddons.delete(terminal);
    });
    terminal.loadAddon(webgl);
    webglAddons.set(terminal, webgl);
  }

  fit.fit();
}

export const StyledTerminalView = styled.div`
  position: absolute;
  inset: 8px 0 0 10px;
  visibility: hidden;

  &[data-active="true"] {
    visibility: visible;
  }
`;

//
// Themes, after VS Code's default dark and light terminal colors.
//

export const TERMINAL_BACKGROUND = { dark: "#1a1b1e", light: "#ffffff" };

const darkTheme: ITheme = {
  background: TERMINAL_BACKGROUND.dark,
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const lightTheme: ITheme = {
  background: TERMINAL_BACKGROUND.light,
  foreground: "#333333",
  cursor: "#333333",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};
