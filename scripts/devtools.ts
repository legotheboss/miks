// Pokes at the running dev app (`yarn dev`) over its DevTools port:
//
//   node scripts/devtools.ts screenshot [out.png]   Saves the window as a PNG.
//   node scripts/devtools.ts eval '<js>'            Prints the result of <js> in the page.
//   node scripts/devtools.ts drop [--alt] <file>...  Drops files on the terminal, as from Finder (holding ⌥).
//
// For checking UI work without OS screen-recording permissions.
import fs from "fs";
import { WebSocket } from "ws";

const PORT = Number(process.env.MIKS_DEVTOOLS_PORT ?? 2739);
const [command, arg] = process.argv.slice(2);

const targets: any[] = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// With more than one window, MIKS_DEVTOOLS_PAGE=<n> picks which (in the
// order DevTools lists them).
const page = targets.filter((t) => t.type === "page")[Number(process.env.MIKS_DEVTOOLS_PAGE ?? 0)];
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
} else if (command === "drop") {
  const { result } = await call("Runtime.evaluate", {
    expression: `(() => { const r = document.querySelector(".terminals > [data-active=true]").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    returnByValue: true,
  });
  const [x, y] = result.value;
  const files = process.argv.slice(3);
  // CDP's modifier bits: 1 is ⌥.
  const modifiers = files[0] === "--alt" ? (files.shift(), 1) : 0;
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await call("Input.dispatchDragEvent", { type, x, y, data, modifiers });
} else {
  console.error("Usage: node scripts/devtools.ts screenshot [out.png] | eval '<js>' | drop [--alt] <file>...");
  process.exit(1);
}

socket.close();
