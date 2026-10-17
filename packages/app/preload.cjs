// The renderer's only door to the daemon, exposed as `window.miks` (typed in
// packages/ui/bridge.ts). CommonJS because sandboxed preloads can't be ESM.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("miks", {
  /** (Re)connects this page to the daemon; status arrives via onStatus. */
  connect: () => ipcRenderer.send("miks:connect"),
  send: (message) => ipcRenderer.send("miks:send", message),
  onMessage: (listener) => subscribe("miks:message", listener),
  onStatus: (listener) => subscribe("miks:status", listener),
  onCommand: (listener) => subscribe("miks:command", listener),
  /** The path of a dropped file; File.path no longer exists in Electron. */
  pathForFile: (file) => webUtils.getPathForFile(file),
});

function subscribe(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
