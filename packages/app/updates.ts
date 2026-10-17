// Updates, from GitHub releases, through Electron's autoUpdater (Squirrel.Mac,
// which checks that an update is signed by the same Developer ID as the app).
// The feed is the update.json `yarn release` attaches to every release, so
// `releases/latest/download/` always has the newest.
import { app, autoUpdater, BrowserWindow, dialog } from "electron";

const FEED_URL = process.env.MIKS_UPDATE_FEED ?? "https://github.com/nfarina/miks/releases/latest/download/update.json";
const CHECK_EVERY = 6 * 60 * 60 * 1000;

let started = false;
/** Whether the next answer should be shown even if it's "nothing new". */
let interactive = false;
let downloaded = false;

/**
 * Checks now and every so often. `confirmQuit` gets the last word on
 * restarting to install (it's what asks before stopping running programs).
 */
export function startUpdates(confirmQuit: () => Promise<boolean>) {
  // The dev build isn't a bundle Squirrel could replace.
  if (!app.isPackaged) return;
  started = true;

  autoUpdater.setFeedURL({ url: FEED_URL, serverType: "json" });

  autoUpdater.on("error", (error) => {
    console.error("Update check failed:", error);
    if (interactive) show({ type: "warning", message: "Couldn't check for updates", detail: error.message });
    interactive = false;
  });

  autoUpdater.on("update-not-available", () => {
    if (interactive) show({ message: "Miks is up to date", detail: `You have the newest version, ${app.getVersion()}.` });
    interactive = false;
  });

  autoUpdater.on("update-available", () => {
    console.log("Downloading an update.");
    if (interactive) show({ message: "Downloading an update", detail: "Miks will tell you when it's ready to install." });
    interactive = false;
  });

  autoUpdater.on("update-downloaded", async (_event, notes, name) => {
    console.log(`Downloaded Miks ${name}.`);
    downloaded = true;
    const { response } = await show({
      message: `Miks ${name} is ready to install`,
      detail: `${notes ? `${notes.trim()}\n\n` : ""}If not now, it installs the next time Miks quits.`,
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0 && (await confirmQuit())) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates();
  setInterval(() => {
    if (!downloaded) autoUpdater.checkForUpdates();
  }, CHECK_EVERY).unref();
}

/** Miks → Check for updates… */
export function checkForUpdates() {
  if (!started) {
    show({ message: "Updates come with Miks.app", detail: "This is a development build; pull and rebuild instead." });
    return;
  }
  if (downloaded) {
    show({ message: "An update is ready", detail: "It installs the next time Miks quits." });
    return;
  }
  interactive = true;
  autoUpdater.checkForUpdates();
}

function show(options: Electron.MessageBoxOptions) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}
