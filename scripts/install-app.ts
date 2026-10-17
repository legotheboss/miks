// `yarn install:app`: builds Miks.app, signs it with the Developer ID in the
// keychain, and swaps it into /Applications, relaunching it if it was running.
//
// A stable Developer ID signature is what lets macOS remember the permissions
// you grant Miks (and so the programs in its terminals) across reinstalls.
//
// Only the UI app is quit. The daemon keeps running from the old bundle, so
// no terminal is touched; it picks up new daemon code whenever it next starts.
import { packager } from "@electron/packager";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import { socketPath } from "miks/shared/paths";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const buildDir = path.join(root, "build");
const stage = path.join(buildDir, "stage");
const bundleId = "com.nfarina.miks";
const installPath = "/Applications/Miks.app";

const run = (command: string, args: string[], options: { cwd?: string } = {}) =>
  execFileSync(command, args, { stdio: "inherit", cwd: options.cwd ?? root });
const output = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();

//
// Sign with the Developer ID, as Brushy does.
//

const identity =
  process.env.APPLE_SIGNING_IDENTITY ||
  output("security", ["find-identity", "-v", "-p", "codesigning"]).match(/"(Developer ID Application: [^"]+)"/)?.[1];
if (!identity) throw new Error("No Developer ID Application identity in the keychain.");
console.log(`Signing identity: ${identity}`);

//
// Stage the app: the same layout as the repo, with only what runs.
//

console.log("Building the UI…");
run("yarn", ["workspace", "ui", "build"]);

fs.rmSync(stage, { recursive: true, force: true });
const copy = (from: string, to = from) =>
  fs.cpSync(path.join(root, from), path.join(stage, to), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (file) => !file.endsWith(".test.ts"),
  });

copy("packages/app/main.ts");
copy("packages/app/preload.cjs");
copy("packages/app/icon/icon.png");
copy("packages/daemon/package.json");
copy("packages/daemon/server");
copy("packages/daemon/shared");
copy("packages/ui/dist");
for (const name of ["node-pty", "ws", "@xterm/headless", "@xterm/addon-serialize"]) {
  copy(`node_modules/${name}`);
}
// The app imports the daemon's shared code as the `miks` package. In the repo
// that's Yarn's symlink to packages/daemon; here it's a stub package that
// re-exports from there, because Node won't run TypeScript from inside
// node_modules, and the packager rewrites symlinks to absolute paths, which
// codesign rightly rejects.
const stub = path.join(stage, "node_modules/miks");
fs.mkdirSync(path.join(stub, "shared"), { recursive: true });
fs.writeFileSync(
  path.join(stub, "package.json"),
  JSON.stringify({ name: "miks", type: "module", exports: { "./shared/*": "./shared/*.js" } }),
);
for (const file of fs.readdirSync(path.join(root, "packages/daemon/shared"))) {
  const name = path.basename(file, ".ts");
  fs.writeFileSync(path.join(stub, `shared/${name}.js`), `export * from "../../../packages/daemon/shared/${file}";\n`);
}

const appPackage = JSON.parse(fs.readFileSync(path.join(root, "packages/app/package.json"), "utf8"));
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "miks",
      productName: "Miks",
      version: appPackage.version,
      type: "module",
      main: "packages/app/main.ts",
    },
    null,
    2,
  ),
);

//
// Package and sign.
//

const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
const usage = (what: string) => `A program running in Miks wants to use ${what}.`;

console.log(`Packaging with Electron ${electronVersion}…`);
const [appDir] = await packager({
  dir: stage,
  out: buildDir,
  name: "Miks",
  platform: "darwin",
  arch: "arm64",
  electronVersion,
  overwrite: true,
  // Plain files: the daemon and main process run TypeScript from source, and
  // node-pty's binaries must sit on disk to be signed and loaded.
  asar: false,
  prune: false,
  derefSymlinks: false,
  icon: path.join(root, "packages/app/icon/Miks.icns"),
  appBundleId: bundleId,
  appCategoryType: "public.app-category.developer-tools",
  darwinDarkModeSupport: true,
  extendInfo: {
    NSAppleEventsUsageDescription: usage("other apps through AppleScript"),
    NSBluetoothAlwaysUsageDescription: usage("Bluetooth"),
    NSCalendarsFullAccessUsageDescription: usage("your calendars"),
    NSCalendarsUsageDescription: usage("your calendars"),
    NSCameraUsageDescription: usage("the camera"),
    NSContactsUsageDescription: usage("your contacts"),
    NSLocationUsageDescription: usage("your location"),
    NSMicrophoneUsageDescription: usage("the microphone"),
    NSPhotoLibraryUsageDescription: usage("your photos"),
    NSRemindersFullAccessUsageDescription: usage("your reminders"),
    NSRemindersUsageDescription: usage("your reminders"),
  },
  osxSign: {
    identity,
    continueOnError: false,
    optionsForFile: (file) =>
      // The app's own binary gets Miks's entitlements; helpers keep the defaults.
      file.endsWith("/Contents/MacOS/Miks") || file.endsWith("Miks.app")
        ? { hardenedRuntime: true, entitlements: path.join(root, "packages/app/entitlements.plist") }
        : { hardenedRuntime: true },
  },
});

const builtApp = path.join(appDir, "Miks.app");
run("codesign", ["--verify", "--deep", "--strict", builtApp]);
console.log(`Built and verified ${path.relative(root, builtApp)}.`);

//
// Swap it into /Applications.
//

// The running UI's processes, from LaunchServices (only the UI registers
// there; the daemon runs on an LSUIElement helper). By pid rather than through
// AppleScript, which looks the app up by bundle ID and, once a bundle has been
// swapped, finds the new one and reports that it isn't running.
//
// Except when it doesn't: a daemon started on the main binary (as older
// builds did) registers too, and this once killed one, and every terminal
// with it. So also leave out whatever answers as the daemon on its socket,
// and anything calling itself miks-daemon.
const daemonPid = () => {
  const ping = spawnSync("curl", ["-sf", "-m", "2", "--unix-socket", socketPath(), "http://miks/api/ping"], {
    encoding: "utf8",
  });
  return ping.status === 0 ? Number(JSON.parse(ping.stdout).pid) : null;
};
const uiPids = () => {
  const daemon = daemonPid();
  return output("lsappinfo", ["find", `bundleid=${bundleId}`])
    .split("\n")
    .filter(Boolean)
    .map((asn) => Number(output("lsappinfo", ["info", "-only", "pid", asn.split(": ")[0]]).match(/pid = (\d+)/)?.[1]))
    .filter((pid) => pid && pid !== daemon)
    .filter((pid) => spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout.trim() !== "miks-daemon");
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Never `pkill -x Miks`: the daemon's helper is in this bundle too, and
// quitting must leave it (and every terminal) alone.
const running = uiPids();
const wasRunning = running.length > 0;
if (wasRunning) {
  console.log("Quitting Miks…");
  // Electron quits cleanly on SIGTERM.
  for (const pid of running) process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && running.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (running.some(alive)) throw new Error("Miks didn't quit; quit it and run this again.");
}

if (fs.existsSync(installPath)) {
  console.log(`Moving the old ${installPath} to the Trash…`);
  run("trash", [installPath]);
}

console.log(`Installing ${installPath}…`);
run("ditto", [builtApp, installPath]);

if (wasRunning) {
  console.log("Relaunching Miks…");
  // `open` hands the app our environment, and through the daemon, every
  // terminal in it. Run from a Claude Code session, as this often is, that
  // included its child-session marker, which stopped Claude Code saving
  // transcripts in every pane. Launch it clean, as the Dock would.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CMUX_|MIKS_|ELECTRON_)/.test(key)),
  );
  execFileSync("open", [installPath], { stdio: "inherit", env });
}

// codesign describes a signature on stderr.
const signature = spawnSync("codesign", ["-dv", "--verbose=4", installPath], { encoding: "utf8" }).stderr;
console.log("Installed:");
for (const line of signature.split("\n").filter((line) => /^(Identifier|Authority)=/.test(line)).slice(0, 3)) {
  console.log(`  ${line}`);
}
