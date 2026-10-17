import { spawn } from "child_process";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import type { MenuItemConstructorOptions, WebContents } from "electron";
import fs from "fs";
import path from "path";
import { logPath, socketPath } from "miks/shared/paths";
import { WebSocket } from "ws";

// The Electron shell is deliberately thin: a window, a menu, and a pipe
// between the renderer and the daemon's Unix socket (which the renderer
// can't open itself). Every terminal lives in the daemon, so quitting this
// app, or reloading its window, leaves them all running.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const daemonMain = path.join(repoRoot, "packages/daemon/server/main.ts");

//
// The daemon.
//

function connectOnce(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath()}:/ws`);
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

  // The daemon runs on the system's Node, not Electron's, so node-pty's
  // prebuilt binary matches it and nothing needs rebuilding for Electron.
  // Apps launched from the Finder get a bare PATH, hence the usual suspects.
  const env = { ...process.env };
  env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  delete env.ELECTRON_RUN_AS_NODE;

  // Detached, so it outlives us: that's the whole point.
  const child = spawn(process.env.MIKS_NODE ?? "node", [daemonMain, "serve"], {
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

  // Links clicked in a terminal open in the real browser.
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.MIKS_UI_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(repoRoot, "packages/ui/dist/index.html"));
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

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window doesn't end any sessions, so there's no reason to
// linger; quitting is as cheap as reloading.
app.on("window-all-closed", () => app.quit());
