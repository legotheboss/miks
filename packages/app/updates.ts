// Updates, from GitHub releases, through Electron's autoUpdater (Squirrel.Mac,
// which checks that an update is signed by the same Developer ID as the app).
// The feed is the update.json `yarn release` attaches to every release, so
// `releases/latest/download/` always has the newest.
import { app, autoUpdater, BrowserWindow, dialog } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

const FEED_URL = process.env.MIKS_UPDATE_FEED ?? "https://github.com/nfarina/miks/releases/latest/download/update.json";
const CHECK_EVERY = 6 * 60 * 60 * 1000;

let started = false;
/** Whether the next answer should be shown even if it's "nothing new". */
let interactive = false;
let downloaded: string | null = null;
/** From a check until its answer: another meanwhile fails ("The command is disabled"). */
let checking = false;
/** `miks update`'s status file, while it's waiting on an answer. */
let shellStatus: string | null = null;
let confirmQuitter: () => Promise<boolean> = async () => true;

/**
 * Checks now and every so often. `confirmQuit` gets the last word on
 * restarting to install (it's what asks before stopping running programs).
 */
export function startUpdates(confirmQuit: () => Promise<boolean>) {
  // The dev build isn't a bundle Squirrel could replace.
  if (!app.isPackaged) return;
  started = true;
  confirmQuitter = confirmQuit;

  autoUpdater.setFeedURL({ url: FEED_URL, serverType: "json" });

  autoUpdater.on("error", (error) => {
    checking = false;
    console.error("Update check failed:", error);
    if (interactive) show({ type: "warning", message: "Couldn't check for updates", detail: error.message });
    interactive = false;
    tellShell(`Couldn't check for updates: ${error.message}`, true);
  });

  autoUpdater.on("update-not-available", () => {
    checking = false;
    if (interactive) show({ message: "Miks is up to date", detail: `You have the newest version, ${app.getVersion()}.` });
    interactive = false;
    tellShell(`Miks is up to date (${app.getVersion()}).`, true);
  });

  autoUpdater.on("update-available", () => {
    console.log("Downloading an update.");
    if (interactive) show({ message: "Downloading an update", detail: "Miks will tell you when it's ready to install." });
    interactive = false;
    tellShell("Downloading an update…");
  });

  autoUpdater.on("update-downloaded", async (_event, notes, name) => {
    console.log(`Downloaded Miks ${name}.`);
    checking = false;
    downloaded = name;
    // Asked for from a terminal: no asking again, there may be nobody there.
    if (shellStatus) return installFromShell();
    const { response } = await show({
      message: `Miks ${name} is ready to install`,
      detail: `${notes ? `${notes.trim()}\n\n` : ""}If not now, it installs the next time Miks quits.`,
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0 && (await confirmQuit())) autoUpdater.quitAndInstall();
  });

  check();
  setInterval(() => {
    if (downloaded === null) check();
  }, CHECK_EVERY).unref();
}

/** Miks → Check for updates… */
export function checkForUpdates() {
  if (!started) {
    show({ message: "Updates come with Miks.app", detail: "This is a development build; pull and rebuild instead." });
    return;
  }
  if (downloaded !== null) {
    show({ message: "An update is ready", detail: "It installs the next time Miks quits." });
    return;
  }
  interactive = true;
  check();
}

/** Checks, or (one is already under way) lets that one answer. */
function check() {
  if (checking) return;
  checking = true;
  autoUpdater.checkForUpdates();
}

/**
 * `miks update`, from a terminal on this Mac (one in a window on another, say,
 * so nobody has to be here): checks, downloads and installs without asking,
 * reporting each step in `status`, a file the command made and prints.
 */
export function updateFromShell(status: string) {
  // Only a file `miks update` made, so nothing else can be written to.
  const real = (file: string) => fs.realpathSync(file);
  try {
    if (!path.basename(status).startsWith("miks-update-") || path.dirname(real(status)) !== real(os.tmpdir())) return;
  } catch {
    return;
  }
  shellStatus = status;

  if (!started) return tellShell("This is a development build; pull and rebuild instead.", true);
  if (downloaded !== null) return installFromShell();
  tellShell("Checking for updates…");
  check();
}

async function installFromShell() {
  // Still asks about running programs if nobody else is connected: then
  // whoever ran it is at this Mac.
  if (!(await confirmQuitter())) return tellShell("Not installed: quitting was cancelled.", true);
  tellShell(`Installing Miks ${downloaded}; it reopens on its own.`, true);
  autoUpdater.quitAndInstall();
}

/** A line for `miks update` to print; `last` ends it. */
function tellShell(line: string, last = false) {
  if (!shellStatus) return;
  try {
    fs.appendFileSync(shellStatus, `${line}\n${last ? "END\n" : ""}`);
  } catch {}
  if (last) shellStatus = null;
}

function show(options: Electron.MessageBoxOptions) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}
