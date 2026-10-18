// Windows on another Mac reach its daemon through SSH, which forwards a local
// Unix socket to the remote one: no daemon listens on the network, and SSH's
// keys are the authentication. One `ssh -N` per remote, started when a window
// first needs it and restarted whenever it dies (sleep, a VPN dropping).
import { type ChildProcess, execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { miksHome } from "miks/shared/paths";
import type { Remote } from "miks/shared/settings";

/** Never prompt (there's no terminal to prompt in), and notice a dead link. */
const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
];

/** MIKS_SSH stands in a fake for testing (scripts/fake-ssh.ts). */
const SSH = process.env.MIKS_SSH || "ssh";

type Tunnel = { child: ChildProcess; socket: string; ready: Promise<void> };

const tunnels = new Map<string, Tunnel>();
/** Each remote's home folder, which the daemon's socket path starts with. */
const remoteHomes = new Map<string, string>();

/** The local end of a remote's tunnel, starting the tunnel if needed. */
export async function tunnelSocket(remote: Remote): Promise<string> {
  let tunnel = tunnels.get(remote.id);
  if (!tunnel || tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
    tunnel = await startTunnel(remote);
  }
  await tunnel.ready;
  return tunnel.socket;
}

export function stopTunnel(id: string) {
  tunnels.get(id)?.child.kill();
  tunnels.delete(id);
}

export function stopAllTunnels() {
  for (const id of [...tunnels.keys()]) stopTunnel(id);
}

async function startTunnel(remote: Remote): Promise<Tunnel> {
  const home = remoteHomes.get(remote.host) ?? (await askHome(remote));
  remoteHomes.set(remote.host, home);

  // Short, since macOS caps socket paths at 104 bytes.
  const socket = path.join(miksHome(), "remotes", `${remote.id}.sock`);
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  fs.rmSync(socket, { force: true });

  const remoteSocket = `${home}/Library/Application Support/Miks/miks.sock`;
  const child = spawn(SSH, [...SSH_OPTIONS, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `${socket}:${remoteSocket}`, remote.host], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk) => (errors += chunk));

  const ready = new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const check = () => {
      if (child.exitCode !== null) return reject(new Error(sshError(remote, errors)));
      if (Date.now() > deadline) {
        child.kill();
        return reject(new Error(`Timed out connecting to ${remote.name}.`));
      }
      // ssh listens on the local end once the connection is up.
      if (fs.existsSync(socket)) return resolve();
      setTimeout(check, 100);
    };
    check();
  });
  // A failure is reported by whoever awaits it; this keeps it from being unhandled.
  ready.catch(() => {});

  const tunnel = { child, socket, ready };
  tunnels.set(remote.id, tunnel);
  child.on("exit", () => {
    if (tunnels.get(remote.id) === tunnel) tunnels.delete(remote.id);
  });
  return tunnel;
}

/** The remote's $HOME: its user may not be ours, nor its home in /Users. */
function askHome(remote: Remote): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SSH, [...SSH_OPTIONS, remote.host, 'printf %s "$HOME"'], { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error || !stdout.startsWith("/")) reject(new Error(sshError(remote, stderr || String(error))));
      else resolve(stdout);
    });
  });
}

/** ssh's complaint, in terms of what to do about it. */
function sshError(remote: Pick<Remote, "name" | "host">, stderr: string): string {
  const said = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (/Permission denied/i.test(said)) {
    return `${remote.name} didn't accept your SSH key. Check that \`ssh ${remote.host}\` works without a password.`;
  }
  if (/Could not resolve|Connection refused|timed out|No route/i.test(said)) {
    return `Couldn't reach ${remote.name} (${said}). Is it awake, with Remote Login on?`;
  }
  return `Couldn't connect to ${remote.name}${said ? `: ${said}` : "."}`;
}
