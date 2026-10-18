import { spawn } from "child_process";
import fs from "fs";
import { logPath, socketPath, statePath } from "../shared/paths.ts";
import { serve } from "./daemon.ts";

const [command] = process.argv.slice(2);

if (command === "serve") {
  // What `ps` and `pkill` see, instead of the binary it runs on.
  process.title = "miks-daemon";

  let stopping = false;
  const daemon = await serve({
    socketPath: socketPath(),
    statePath: statePath(),
    onStop: (restart) => {
      if (stopping) return;
      stopping = true;
      log(restart ? "Restarting." : "The last window left after Miks quit; exiting.");
      daemon.close().finally(() => {
        // The same daemon again, from the same files (so any new code), once
        // this one has let go of the socket. It restores the saved layout.
        if (restart) {
          const output = fs.openSync(logPath(), "a");
          spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ["ignore", output, output] }).unref();
        }
        process.exit(0);
      });
    },
  });

  // Start with something to look at.
  if (!daemon.restored) daemon.workspaces.createWorkspace();

  log(`Listening on ${socketPath()} (pid ${process.pid}).`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`Got ${signal}; exiting.`);
      daemon.close().finally(() => process.exit(0));
    });
  }
} else {
  console.error("Usage: miks serve");
  process.exit(1);
}

function log(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  if (!process.stdout.isTTY) return;
  // When run by hand, also keep the log the UI-spawned daemon would write.
  fs.appendFileSync(logPath(), line);
}
