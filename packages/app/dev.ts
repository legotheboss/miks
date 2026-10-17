// `yarn dev`: the UI's Vite server with hot reload, inside Electron. Edits to
// the UI hot-reload in place; edits to the Electron side restart Electron.
// Neither touches the daemon, so your terminals keep running throughout.
import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { createServer } from "vite";

const appDir = import.meta.dirname;
const uiDir = path.resolve(appDir, "../ui");

const server = await createServer({
  root: uiDir,
  configFile: path.join(uiDir, "vite.config.ts"),
  server: { port: 2738, strictPort: true },
});
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("Vite didn't report a URL.");
server.printUrls();

const DEVTOOLS_PORT = 2739;
const electronBin = path.resolve(appDir, "../../node_modules/.bin/electron");
let electron: ChildProcess | null = null;
let restarting = false;

function startElectron() {
  // The DevTools port lets scripts/devtools.ts screenshot and inspect the
  // window, which is how agents check their UI work. Dev only.
  electron = spawn(electronBin, [`--remote-debugging-port=${DEVTOOLS_PORT}`, appDir], {
    stdio: "inherit",
    env: { ...process.env, MIKS_UI_URL: url },
  });
  electron.on("exit", (code, signal) => {
    if (restarting) return;

    // A crash (usually a broken edit to main.ts) waits for the next edit
    // instead of ending `yarn dev`.
    if (code !== 0 || signal) {
      electron = null;
      console.log(`Electron exited (${signal ?? `code ${code}`}); fix it and save to start it again.`);
      return;
    }

    // Quitting the app ends `yarn dev` too.
    server.close().finally(() => process.exit(0));
  });
}

let timer: NodeJS.Timeout | null = null;
// The folder, not the files: an editor that saves by replacing a file (most
// do, as does `sed -i`) leaves a watch on the file itself watching nothing.
fs.watch(appDir, (_event, file) => {
  if (file !== "main.ts" && file !== "preload.cjs") return;

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`${file} changed; restarting Electron.`);
    if (!electron) return startElectron();

    restarting = true;
    electron.once("exit", () => {
      restarting = false;
      startElectron();
    });
    // SIGUSR2 quits leaving the daemon running; SIGTERM would stop it.
    electron.kill("SIGUSR2");
  }, 200);
});

// Killing `yarn dev` takes its Electron with it, instead of leaving it open.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restarting = true;
    electron?.kill("SIGUSR2");
    server.close().finally(() => process.exit(0));
  });
}

startElectron();
