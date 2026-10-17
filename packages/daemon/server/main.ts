import fs from "fs";
import { logPath, socketPath } from "../shared/paths.ts";
import { serve } from "./daemon.ts";

const [command] = process.argv.slice(2);

if (command === "serve") {
  const daemon = await serve({ socketPath: socketPath() });

  // Start with something to look at.
  daemon.workspaces.createWorkspace();

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
