import { spawn } from "child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import type { MenuItemConstructorOptions, WebContents } from "electron";
import fs from "fs";
import http from "http";
import path from "path";
import { connectDaemon as openDaemonSocket } from "miks/shared/connect";
import { logPath, miksHome, socketPath } from "miks/shared/paths";
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import type { WebSocket } from "ws";

// The Electron shell is deliberately thin: a window, a menu, and a pipe
// between the renderer and the daemon's Unix socket (which the renderer
// can't open itself). Every terminal lives in the daemon, so quitting this
// app, or reloading its window, leaves them all running.

// The repo in development; Contents/Resources/app inside Miks.app.
const root = path.resolve(import.meta.dirname, "../..");
const daemonMain = path.join(root, "packages/daemon/server/main.ts");
const iconPath = path.join(root, "packages/app/icon/icon.png");

//
// The daemon.
//

function connectOnce(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = openDaemonSocket(socketPath());
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Connects to the daemon, starting it first if nothing is listening. */
async function connectDaemon(): Promise<WebSocket> {
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

ipcMain.on("miks:connect", (event) => linkWindow(event.sender));

async function linkWindow(contents: WebContents) {
  links.get(contents)?.close();
  links.delete(contents);

  let socket: WebSocket;
  try {
    socket = await connectDaemon();
  } catch (error) {
    contents.send("miks:status", { connected: false, error: String(error) });
    return;
  }

  if (contents.isDestroyed()) return socket.close();
  links.set(contents, socket);

  socket.on("message", (data) => {
    if (!contents.isDestroyed()) contents.send("miks:message", data.toString());
  });
  socket.on("close", () => {
    if (links.get(contents) !== socket) return;
    links.delete(contents);
    if (!contents.isDestroyed()) contents.send("miks:status", { connected: false });
  });

  contents.send("miks:status", { connected: true });
}

ipcMain.on("miks:send", (event, message: string) => {
  links.get(event.sender)?.send(message);
});

/** A GET against the daemon's HTTP API, or null if it isn't answering. */
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

  for (const window of BrowserWindow.getAllWindows()) linkWindow(window.webContents);
}

//
// The window.
//

function createWindow() {
  const saved = loadWindowState();
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    ...saved?.bounds,
    minWidth: 500,
    minHeight: 300,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const contents = window.webContents;
  contents.on("destroyed", () => {
    links.get(contents)?.close();
    links.delete(contents);
  });

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
  rememberWindowState(window);

  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
}

//
// Where the window was, in the UI's profile folder, so it reopens there.
//

type WindowState = { bounds: Electron.Rectangle; maximized: boolean };

const windowStatePath = () => path.join(app.getPath("userData"), "window.json");

function loadWindowState(): WindowState | null {
  try {
    const state: WindowState = JSON.parse(fs.readFileSync(windowStatePath(), "utf8"));
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

function rememberWindowState(window: BrowserWindow) {
  let timer: NodeJS.Timeout | null = null;

  const save = () => {
    if (window.isDestroyed() || window.isFullScreen()) return;
    // The size it returns to when un-maximized, not the maximized size.
    const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state));
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

let mainWindow: BrowserWindow | null = null;

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

// A notification was clicked: bring Miks forward.
ipcMain.on("miks:focus", () => {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
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
  settings = { ...settings, ...changes };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("miks:settings", settings);
});


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
        command("settings", "CmdOrCtrl+,", "Settings…"),
        { type: "separator" },
        {
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
      ],
    },
    { role: "editMenu" },
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
        command("nextWorkspace", "CmdOrCtrl+Shift+Down", "Next workspace"),
        command("previousWorkspace", "CmdOrCtrl+Shift+Up", "Previous workspace"),
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window doesn't end any sessions, so there's no reason to
// linger; quitting is as cheap as reloading.
app.on("window-all-closed", () => app.quit());
