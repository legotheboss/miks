#!/usr/bin/env node
// Stands in for `ssh` when testing remote windows without another Mac
// (MIKS_SSH=scripts/fake-ssh.ts): `-L local:remote ... -N` forwards a local
// Unix socket to another on this Mac, and a command answers $HOME with
// FAKE_SSH_HOME, so a second scratch daemon there plays the remote.
import fs from "fs";
import net from "net";

const args = process.argv.slice(2);
const forward = args[args.indexOf("-L") + 1];

if (!args.includes("-N")) {
  process.stdout.write(process.env.FAKE_SSH_HOME ?? "/tmp/fake-home");
  process.exit(0);
}

const split = forward.indexOf(":");
const [local, remote] = [forward.slice(0, split), forward.slice(split + 1)];
fs.rmSync(local, { force: true });
net
  .createServer((client) => {
    const upstream = net.connect(remote);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  })
  .listen(local);
process.on("SIGTERM", () => process.exit(0));
