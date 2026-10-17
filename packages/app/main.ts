import { spawn } from "child_process";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import type { MenuItemConstructorOptions, WebContents } from "electron";
import fs from "fs";
import path from "path";
import { connectDaemon as openDaemonSocket } from "miks/shared/connect";
import { logPath, miksHome, socketPath } from "miks/shared/paths";
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
  const child = spawn(process.execPath, [daemonMain, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  child.unref();
  fs.closeSync(log);
}

/**
 * One daemon connection per window, replaced whenever the window's page
 * (re)loads so the daemon never streams to terminals that no longer exist.
 */
const links = new Map<WebContents, WebSocket>();

ipcMain.on("miks:connect", async (event) => {
  const contents = event.sender;
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
});

ipcMain.on("miks:send", (event, message: string) => {
  links.get(event.sender)?.send(message);
});

//
// The window.
//

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 500,
    minHeight: 300,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#1a1b1e",
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
    { role: "appMenu" },
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
        command("nextWorkspace", "CmdOrCtrl+Alt+Down", "Next workspace"),
        command("previousWorkspace", "CmdOrCtrl+Alt+Up", "Previous workspace"),
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
