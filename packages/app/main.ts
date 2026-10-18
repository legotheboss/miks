import { spawn } from "child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import type { MenuItemConstructorOptions, WebContents } from "electron";
import fs from "fs";
import http from "http";
import path from "path";
import { connectDaemon as openDaemonSocket } from "miks/shared/connect";
import { logPath, miksHome, socketPath } from "miks/shared/paths";
import { DEFAULT_SETTINGS, displayPath, type Remote, type Settings } from "miks/shared/settings";
import os from "os";
import type { WebSocket } from "ws";
import { syncClaudeHooks } from "./claudeHooks.ts";
import { stopAllTunnels, stopTunnel, tunnelSocket } from "./tunnels.ts";
import { checkForUpdates, startUpdates } from "./updates.ts";

// The Electron shell is deliberately thin: windows, a menu, and a pipe
// between each window and a daemon's Unix socket (which the renderer can't
// open itself). Every terminal lives in a daemon, so reloading a window leaves
// them all running. A window is on this Mac's daemon, or on a remote's,
// through an SSH tunnel (tunnels.ts); one window per daemon.

// The repo in development; Contents/Resources/app inside Miks.app.
const root = path.resolve(import.meta.dirname, "../..");
const daemonMain = path.join(root, "packages/daemon/server/main.ts");
const iconPath = path.join(root, "packages/app/icon/icon.png");

//
// The daemon.
//

function connectOnce(socketFile = socketPath()): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = openDaemonSocket(socketFile);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * Connects to this Mac's daemon, starting it first if nothing is listening,
 * or to a remote's, which is only ever started there.
 */
async function connectDaemon(remote: Remote | null): Promise<WebSocket> {
  if (remote) {
    const socket = await tunnelSocket(remote);
    try {
      return await connectOnce(socket);
    } catch {
      throw new Error(`Miks isn't running on ${remote.name}. Open it there, and this window will connect.`);
    }
  }

  try {
    return await connectOnce();
  } catch {
    startDaemon();
  }

  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await connectOnce();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function startDaemon() {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logPath(), "a");

  // The daemon runs on our own binary as plain Node (node-pty's prebuilt
  // binary uses Node-API, so it loads in any Node), which needs nothing
  // installed and makes macOS attribute the daemon, and the programs in its
  // terminals, to Miks. Apps launched from the Finder get a bare PATH, hence
  // the usual suspects.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

  // Detached, so it outlives us: that's the whole point.
  const child = spawn(helperPath(), [daemonMain, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  child.unref();
  fs.closeSync(log);
}

/**
 * The plain helper inside our bundle ("Miks Helper", or "Electron Helper" in
 * development), which the daemon runs on. Not our own executable: macOS
 * takes launching an app's main binary as launching the app, and bounces it
 * in the Dock waiting for a window that never comes. The helper is
 * LSUIElement, so it has no Dock icon at all.
 */
function helperPath(): string {
  const name = path.basename(process.execPath);
  const helper = path.join(
    path.dirname(process.execPath),
    `../Frameworks/${name} Helper.app/Contents/MacOS/${name} Helper`,
  );
  return fs.existsSync(helper) ? helper : process.execPath;
}

/**
 * One daemon connection per window, replaced whenever the window's page
 * (re)loads so the daemon never streams to terminals that no longer exist.
 */
const links = new Map<WebContents, WebSocket>();
/** Which remote each window is on, by id; null for this Mac. */
const windowRemotes = new Map<WebContents, string | null>();
/** Remote windows try again on their own; this is when, for each. */
const retries = new Map<WebContents, NodeJS.Timeout>();

const remoteFor = (contents: WebContents): Remote | null => {
  const id = windowRemotes.get(contents);
  return (id && settings.remotes.find((remote) => remote.id === id)) || null;
};

ipcMain.on("miks:connect", (event) => linkWindow(event.sender));

async function linkWindow(contents: WebContents) {
  links.get(contents)?.close();
  links.delete(contents);
  clearTimeout(retries.get(contents));

  const remote = remoteFor(contents);
  const retry = (error: string) => {
    if (contents.isDestroyed()) return;
    contents.send("miks:status", { connected: false, error, retrying: !!remote });
    if (remote) retries.set(contents, setTimeout(() => linkWindow(contents), 3000));
  };

  if (windowRemotes.get(contents) && !remote) {
    return contents.send("miks:status", { connected: false, error: "This machine was removed in Settings." });
  }

  let socket: WebSocket;
  try {
    socket = await connectDaemon(remote);
  } catch (error) {
    return retry(error instanceof Error ? error.message : String(error));
  }

  if (contents.isDestroyed()) return socket.close();
  links.set(contents, socket);

  socket.on("message", (data) => {
    if (!contents.isDestroyed()) contents.send("miks:message", data.toString());
  });
  socket.on("close", () => {
    if (links.get(contents) !== socket) return;
    links.delete(contents);
    if (remote) retry(`Lost the connection to ${remote.name}. Reconnecting…`);
    else if (!contents.isDestroyed()) contents.send("miks:status", { connected: false });
  });

  contents.send("miks:status", { connected: true });
  if (!remote) openPendingFolders();
}

ipcMain.on("miks:send", (event, message: string) => {
  links.get(event.sender)?.send(message);
});

/** A GET against this Mac's daemon's HTTP API, or null if it isn't answering. */
function daemonGet(apiPath: string): Promise<any> {
  return new Promise((resolve) => {
    const request = http.get({ socketPath: socketPath(), path: apiPath }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(JSON.parse(body)));
    });
    request.on("error", () => resolve(null));
  });
}

/**
 * Stops the daemon, ending every terminal, and reconnects every window,
 * which starts a fresh one. How new daemon code takes effect.
 */
async function restartDaemon(window: BrowserWindow | undefined) {
  const [ping, state] = await Promise.all([daemonGet("/api/ping"), daemonGet("/api/state")]);
  const tabs = (state?.workspaces ?? []).reduce((count: number, w: any) => count + w.tabs.length, 0);

  const options = {
    type: "warning" as const,
    message: "Restart the daemon?",
    detail: `This ends every terminal session${tabs ? ` (${tabs} open)` : ""}, including any agents running in them.`,
    buttons: ["Restart", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response !== 0) return;

  if (ping?.pid) {
    process.kill(ping.pid, "SIGTERM");
    // Wait for it to let go of the socket, so we don't reconnect to it.
    for (let i = 0; i < 50 && (await daemonGet("/api/ping")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  for (const [contents, remote] of windowRemotes) if (!remote) linkWindow(contents);
}

//
// The window.
//

/** One window per daemon: "local", or a remote's id. */
const windows = new Map<string, BrowserWindow>();
const LOCAL = "local";

/** Brings forward the window on that daemon, opening it if there's none. */
function openWindow(remoteId: string | null = null): BrowserWindow {
  const window = windows.get(remoteId ?? LOCAL);
  if (!window) return createWindow(remoteId);
  if (window.isMinimized()) window.restore();
  window.show();
  return window;
}

function createWindow(remoteId: string | null = null) {
  const key = remoteId ?? LOCAL;
  const remote = remoteId ? settings.remotes.find((r) => r.id === remoteId) : null;
  const saved = loadWindowState(key);
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    ...saved?.bounds,
    minWidth: 500,
    minHeight: 300,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: windowBackground(),
    // For the Window menu and Mission Control; the page has its own titlebar.
    title: remote ? `Miks — ${remote.name}` : "Miks",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const contents = window.webContents;
  windowRemotes.set(contents, remoteId);
  contents.on("destroyed", () => {
    links.get(contents)?.close();
    links.delete(contents);
    clearTimeout(retries.get(contents));
    windowRemotes.delete(contents);
  });
  // The page would title the window after itself.
  window.on("page-title-updated", (event) => event.preventDefault());

  // Nothing navigates the window away from the UI (a stray file drop would).
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(contents.getURL()).origin) event.preventDefault();
  });

  // Links clicked in a terminal open in the real browser.
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.MIKS_UI_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(root, "packages/ui/dist/index.html"));

  if (saved?.maximized) window.maximize();
  rememberWindowState(window, key);

  windows.set(key, window);
  // Not for this Mac's, which opens first, before the list is read.
  if (remoteId) rememberOpenRemotes();
  window.on("closed", () => {
    if (windows.get(key) === window) windows.delete(key);
    // Closed by hand, it stays closed; open when Miks quit, it comes back.
    if (!quitting) rememberOpenRemotes();
    if (remoteId && !windows.has(key)) stopTunnel(remoteId);
  });
  return window;
}

//
// Remote windows open when Miks last quit open again with it.
//

const openRemotesPath = () => path.join(app.getPath("userData"), "remote-windows.json");

function rememberOpenRemotes() {
  const ids = [...windows.keys()].filter((key) => key !== LOCAL);
  fs.writeFileSync(openRemotesPath(), JSON.stringify(ids));
}

function reopenRemotes() {
  try {
    const ids: string[] = JSON.parse(fs.readFileSync(openRemotesPath(), "utf8"));
    for (const id of ids) if (settings.remotes.some((remote) => remote.id === id)) openWindow(id);
  } catch {}
}

/** What a window's page shows of the machine it's on: null for this Mac. */
const targetFor = (contents: WebContents) => {
  const remote = remoteFor(contents);
  return remote ? { name: remote.name, color: remote.color, host: remote.host } : null;
};

ipcMain.on("miks:getTarget", (event) => {
  event.returnValue = targetFor(event.sender);
});

ipcMain.on("miks:openRemote", (_event, id: string) => {
  if (settings.remotes.some((remote) => remote.id === id)) openWindow(id);
});

//
// Where the window was, in the UI's profile folder, so it reopens there.
//

type WindowState = { bounds: Electron.Rectangle; maximized: boolean };

// Each daemon's window has its own: window.json for this Mac's.
const windowStatePath = (key: string) =>
  path.join(app.getPath("userData"), key === LOCAL ? "window.json" : `window-${key}.json`);

function loadWindowState(key: string): WindowState | null {
  try {
    const state: WindowState = JSON.parse(fs.readFileSync(windowStatePath(key), "utf8"));
    // Somewhere you can still see: not on a display that's since gone away.
    const { bounds } = state;
    const visible = screen.getAllDisplays().some(({ workArea: area }) =>
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y,
    );
    return visible ? state : null;
  } catch {
    return null;
  }
}

function rememberWindowState(window: BrowserWindow, key: string) {
  let timer: NodeJS.Timeout | null = null;

  const save = () => {
    if (window.isDestroyed() || window.isFullScreen()) return;
    // The size it returns to when un-maximized, not the maximized size.
    const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    fs.writeFileSync(windowStatePath(key), JSON.stringify(state));
  };
  const saveSoon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };

  window.on("resize", saveSoon);
  window.on("move", saveSoon);
  window.on("maximize", saveSoon);
  window.on("unmaximize", saveSoon);
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

/**
 * What the window shows before the page paints: the UI's own background for
 * the current appearance, so a launch doesn't flash the wrong one.
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#1a1b1e" : "#ffffff";
}

nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(windowBackground());
});

// A notification was clicked: bring its window forward.
ipcMain.on("miks:focus", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  app.focus({ steal: true });
});

//
// Settings, in settings.json, shared by every window.
//

const settingsPath = path.join(miksHome(), "settings.json");
let settings: Settings = loadSettings();

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

ipcMain.on("miks:getSettings", (event) => {
  event.returnValue = settings;
});

ipcMain.on("miks:setSettings", (_event, changes: Partial<Settings>) => {
  const previous = settings.remotes;
  settings = { ...settings, ...changes };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("miks:settings", settings);
  if ("claudeHooks" in changes) updateClaudeHooks();
  if ("remotes" in changes) remotesChanged(previous);
});

/**
 * A remote was added, edited or removed: the menu lists them, and windows on
 * one that changed reconnect (through a new tunnel, if its host did).
 */
function remotesChanged(previous: Remote[]) {
  buildMenu();
  for (const [contents, id] of windowRemotes) {
    if (!id) continue;
    const before = previous.find((remote) => remote.id === id);
    const now = settings.remotes.find((remote) => remote.id === id);
    if (!contents.isDestroyed()) contents.send("miks:target", targetFor(contents));
    if (now && before?.host === now.host) continue;
    stopTunnel(id);
    if (now) linkWindow(contents);
    else BrowserWindow.fromWebContents(contents)?.close();
  }
}

function updateClaudeHooks() {
  // A scratch Miks (MIKS_HOME) mustn't rewire the real Claude Code's hooks.
  if (process.env.MIKS_HOME) return;
  try {
    syncClaudeHooks({
      enabled: settings.claudeHooks,
      bundledScript: path.join(root, "packages/daemon/hooks/claude-hook.sh"),
      installedScript: path.join(miksHome(), "claude-hook.sh"),
      claudeSettingsPath: path.join(os.homedir(), ".claude/settings.json"),
    });
  } catch (error) {
    console.error("Couldn't update Claude Code's hooks:", error);
  }
}

//
// Opening a folder in Miks (`open -a Miks <folder>`, which is what GitHub
// Desktop's custom shell does, or a folder dropped on the Dock icon) selects
// the workspace already there, or makes one.
//

const pendingFolders: string[] = [];

app.on("open-file", (event, file) => {
  event.preventDefault();
  openFolder(file);
});

// Or given as arguments, launching Miks.app's binary directly.
if (app.isPackaged) for (const arg of process.argv.slice(1)) if (!arg.startsWith("-")) openFolder(arg);

function openFolder(file: string) {
  let folder: string;
  try {
    folder = fs.statSync(file).isDirectory() ? file : path.dirname(file);
  } catch {
    return;
  }
  pendingFolders.push(path.resolve(folder));
  if (app.isReady()) openPendingFolders();
}

async function openPendingFolders() {
  if (pendingFolders.length === 0) return;
  // Folders are this Mac's, so always its window.
  const window = app.isReady() ? openWindow() : null;
  // Once connected; linkWindow calls back.
  const link = window && links.get(window.webContents);
  if (!window || !link) return;

  const folders = pendingFolders.splice(0);
  const state = await daemonGet("/api/state");
  for (const folder of folders) {
    const existing = (state?.workspaces ?? []).find(
      (w: any) => w.cwd === folder || w.tabs.some((tab: any) => tab.cwd === folder),
    );
    link.send(
      JSON.stringify(existing ? { type: "select", workspaceId: existing.id } : { type: "createWorkspace", cwd: folder }),
    );
  }

  if (window.isMinimized()) window.restore();
  window.show();
  app.focus({ steal: true });
}


//
// The menu. Accelerators reach us before the terminal sees the keystroke,
// which is how ⌘T and friends work while a terminal has focus.
//

function command(name: string, accelerator: string, label: string): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, window) => (window as BrowserWindow | undefined)?.webContents.send("miks:command", name),
  };
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Check for updates…", click: () => checkForUpdates() },
        { type: "separator" },
        command("settings", "CmdOrCtrl+,", "Settings…"),
        { type: "separator" },
        {
          // This Mac's: another Mac's daemon is its own business.
          label: "Restart daemon…",
          click: (_item, window) => restartDaemon(window as BrowserWindow | undefined),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        command("newTab", "CmdOrCtrl+T", "New tab"),
        command("newWorkspace", "CmdOrCtrl+N", "New workspace"),
        { type: "separator" },
        command("closeTab", "CmdOrCtrl+W", "Close tab"),
        command("closeWorkspace", "CmdOrCtrl+Shift+W", "Close workspace"),
        { type: "separator" },
        {
          label: "Open window on",
          submenu: [
            { label: "This Mac", click: () => openWindow() },
            ...(settings.remotes.length ? [{ type: "separator" as const }] : []),
            ...settings.remotes.map((remote) => ({ label: remote.name, click: () => openWindow(remote.id) })),
            { type: "separator" },
            {
              label: "Add a Mac…",
              click: (_item, window) => (window as BrowserWindow | undefined ?? openWindow()).webContents.send("miks:command", "settingsRemotes"),
            },
          ],
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        // For pasting a command and what it printed into an agent elsewhere.
        command("selectLastCommand", "CmdOrCtrl+Shift+A", "Select last command"),
        command("clearToStart", "CmdOrCtrl+K", "Clear to start"),
      ],
    },
    {
      label: "View",
      submenu: [
        command("toggleSidebar", "CmdOrCtrl+B", "Toggle sidebar"),
        { type: "separator" },
        command("fontBigger", "CmdOrCtrl+=", "Bigger text"),
        command("fontSmaller", "CmdOrCtrl+-", "Smaller text"),
        command("fontReset", "CmdOrCtrl+0", "Actual size"),
        { type: "separator" },
        // Reloading the UI is free: the terminals live in the daemon.
        { role: "reload", label: "Reload UI" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        command("nextTab", "CmdOrCtrl+Shift+]", "Next tab"),
        command("previousTab", "CmdOrCtrl+Shift+[", "Previous tab"),
        // As in cmux.
        command("nextWorkspace", "Cmd+Ctrl+]", "Next workspace"),
        command("previousWorkspace", "Cmd+Ctrl+[", "Previous workspace"),
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, i) => command(`workspace${i + 1}`, `CmdOrCtrl+${i + 1}`, `Workspace ${i + 1}`)),
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("Miks");

// Electron keeps its browser profile under the app's name by default, which
// is the daemon's own folder; give it a room of its own there.
app.setPath("userData", path.join(miksHome(), "UI"));

app.whenReady().then(() => {
  // Miks.app has its icon in its bundle; the dev build is plain Electron.
  if (!app.isPackaged) app.dock?.setIcon(iconPath);
  buildMenu();
  createWindow();
  reopenRemotes();
  updateClaudeHooks();
  startUpdates(confirmQuitForUpdate);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => stopAllTunnels());

// Closing the last window quits, like a terminal app.
app.on("window-all-closed", () => app.quit());

//
// Quitting. Like any terminal app, quitting ends the terminals (it stops the
// daemon), asking first if programs are running in them. Except: with
// "Keep terminals running" on; when another window still uses the daemon (the
// dev build beside Miks.app); and when install-app relaunches us (SIGUSR2).
// The daemon saves its layout as it stops, so the next launch brings it back
// and resumes the Claude sessions in it.
//

let quitChecked = false;
let relaunching = false;
/** Windows closing now are closing because Miks is quitting. */
let quitting = false;

process.on("SIGUSR2", () => {
  relaunching = true;
  app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  if (quitChecked || relaunching || settings.keepDaemonRunning) return;
  event.preventDefault();
  stopDaemonForQuit().then((quit) => {
    if (!quit) {
      quitting = false;
      return;
    }
    quitChecked = true;
    app.quit();
  });
});

/** Restarting to install an update is a quit like any other. */
async function confirmQuitForUpdate(): Promise<boolean> {
  if (!relaunching && !settings.keepDaemonRunning && !(await stopDaemonForQuit())) return false;
  quitChecked = true;
  return true;
}

/** Stops the daemon, unless that means stopping programs you'd rather keep. */
async function stopDaemonForQuit(): Promise<boolean> {
  // Only ever this Mac's daemon, and only its windows count.
  const localLinks = [...links].filter(([contents]) => !windowRemotes.get(contents));
  const ping = await daemonGet("/api/ping");
  if (!ping?.pid) return true;
  if ((ping.clients ?? 0) > localLinks.length) return true;

  const running = await runningPrograms();
  if (running.length > 0) {
    const shown = running.slice(0, 8);
    const more = running.length - shown.length;
    const options = {
      type: "warning" as const,
      message: "Quit Miks?",
      detail:
        `Quitting stops what's running in its terminals:\n\n${shown.join("\n")}` +
        (more ? `\nand ${more} more` : "") +
        `\n\nTo keep terminals running after Miks quits, turn on "Keep terminals running" in Settings.`,
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    };
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response !== 0) return false;
  }

  // Let go of it first, so no window reconnects (and restarts it) as it goes.
  for (const [contents, socket] of localLinks) {
    socket.close();
    links.delete(contents);
  }
  process.kill(ping.pid, "SIGTERM");
  return true;
}

/** "claude in sage", one per program in front of a shell. */
async function runningPrograms(): Promise<string[]> {
  const result = await daemonGet("/api/running");
  if (Array.isArray(result?.running)) {
    return result.running.map(({ program, cwd }: { program: string; cwd: string | null }) =>
      cwd ? `${program} in ${displayPath(cwd, settings.hidePathPrefix, app.getPath("home"))}` : program,
    );
  }

  // A daemon from before /api/running: all we can say is how many terminals.
  const state = await daemonGet("/api/state");
  const tabs = (state?.workspaces ?? []).reduce((count: number, w: any) => count + w.tabs.length, 0);
  return tabs ? [`${tabs} terminal${tabs === 1 ? "" : "s"}`] : [];
}
