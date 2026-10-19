// Builds Miks.app, signed with the Developer ID in the keychain (as Brushy
// is), into build/Miks-darwin-arm64. Used by `yarn install:app` and
// `yarn release`.
import { packager } from "@electron/packager";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export const root = path.resolve(import.meta.dirname, "..");
export const bundleId = "com.nfarina.miks";
const buildDir = path.join(root, "build");
const stage = path.join(buildDir, "stage");

export const run = (command: string, args: string[], options: { cwd?: string } = {}) =>
  execFileSync(command, args, { stdio: "inherit", cwd: options.cwd ?? root });
export const output = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();

/** Returns the built app's path. */
export async function buildApp(): Promise<string> {
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
  copy("packages/app/claudeHooks.ts");
  copy("packages/app/updates.ts");
  copy("packages/app/tunnels.ts");
  copy("packages/daemon/hooks");
  copy("packages/daemon/shell");
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
      // Folders, so one dropped on the Dock icon, or `open -a Miks <folder>`
      // (GitHub Desktop's custom shell), opens a workspace there. Rank
      // None: Miks is never what opens a folder by default.
      CFBundleDocumentTypes: [
        { CFBundleTypeName: "Folder", CFBundleTypeRole: "Viewer", LSHandlerRank: "None", LSItemContentTypes: ["public.folder"] },
      ],
      NSAppleEventsUsageDescription: usage("other apps through AppleScript"),
      NSBluetoothAlwaysUsageDescription: usage("Bluetooth"),
      NSCalendarsFullAccessUsageDescription: usage("your calendars"),
      NSCalendarsUsageDescription: usage("your calendars"),
      NSCameraUsageDescription: usage("the camera"),
      NSContactsUsageDescription: usage("your contacts"),
      NSLocationUsageDescription: usage("your location"),
      // Without it macOS never asks, and connections from terminals to other
      // machines on your network fail at random ("Undefined error: 0" from
      // ssh), though the internet, and anything over a VPN, work.
      NSLocalNetworkUsageDescription: usage("devices on your local network"),
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
  return builtApp;
}
