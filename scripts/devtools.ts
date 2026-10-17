// Pokes at the running dev app (`yarn dev`) over its DevTools port:
//
//   node scripts/devtools.ts screenshot [out.png]   Saves the window as a PNG.
//   node scripts/devtools.ts eval '<js>'            Prints the result of <js> in the page.
//
// For checking UI work without OS screen-recording permissions.
import fs from "fs";
import { WebSocket } from "ws";

const PORT = 2739;
const [command, arg] = process.argv.slice(2);

const targets: any[] = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("No page found; is `yarn dev` running?");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

let nextId = 1;
function call(method: string, params: any = {}): Promise<any> {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    socket.on("message", function listener(raw) {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      socket.off("message", listener);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  });
}

if (command === "screenshot") {
  const out = arg ?? "screenshot.png";
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(out);
} else if (command === "eval") {
  const { result, exceptionDetails } = await call("Runtime.evaluate", {
    expression: arg,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  console.log(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
} else {
  console.error("Usage: node scripts/devtools.ts screenshot [out.png] | eval '<js>'");
  process.exit(1);
}

socket.close();
