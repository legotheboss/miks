// `yarn install:app`: builds Miks.app, signs it with the Developer ID in the
// keychain, and swaps it into /Applications, relaunching it if it was running.
//
// A stable Developer ID signature is what lets macOS remember the permissions
// you grant Miks (and so the programs in its terminals) across reinstalls.
//
// Only the UI app is quit. The daemon keeps running from the old bundle, so
// no terminal is touched; it picks up new daemon code whenever it next starts.
import { execFileSync, spawnSync } from "child_process";
import { socketPath } from "miks/shared/paths";
import { buildApp, bundleId, output, run } from "./build-app.ts";

const installPath = "/Applications/Miks.app";
const builtApp = await buildApp();

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
  // SIGUSR2 is our "quit, leaving the daemon running" (packages/app/main.ts);
  // SIGTERM is an ordinary quit, which would stop it.
  for (const pid of running) process.kill(pid, "SIGUSR2");
  for (let i = 0; i < 50 && running.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (running.some(alive)) throw new Error("Miks didn't quit; quit it and run this again.");
}

// Updated in place, not swapped for a new bundle: the daemon keeps running
// from this bundle across installs, and macOS names it (in permission
// prompts, say) after wherever that bundle is. Moved to the Trash, it showed
// up as "Miks 11-23-24-642". rsync writes each file under a temporary name
// and renames it into place, so running processes keep the files they have.
console.log(`Installing ${installPath}…`);
run("rsync", ["-a", "--delete", `${builtApp}/`, `${installPath}/`]);
run("codesign", ["--verify", "--deep", "--strict", installPath]);

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
