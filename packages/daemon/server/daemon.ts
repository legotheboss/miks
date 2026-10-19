import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, DaemonMessage } from "../shared/protocol.ts";
import type { PaneViewer } from "./Pane.ts";
import { type SavedState, Workspaces } from "./Workspaces.ts";

export type Daemon = {
  workspaces: Workspaces;
  /** Whether a saved layout was brought back. */
  restored: boolean;
  /** Saves the layout (when persisting), then ends every pane. */
  close(): Promise<void>;
};

/**
 * Serves the daemon on a Unix socket: a WebSocket at `/ws` for UIs, and a
 * small HTTP API for hooks. A Unix socket rather than a TCP port because
 * anything that can connect can type into your shells; this way that's only
 * processes running as you, and no web page can reach it the way it could
 * reach localhost.
 */
export async function serve({
  socketPath,
  statePath,
  command,
  claudeCommand,
  onStop,
}: {
  socketPath: string;
  /** Where the layout is saved and restored from; none, no persistence. */
  statePath?: string;
  /** What each pane runs, instead of a login shell. For tests. */
  command?: string[];
  /** What resumes a Claude session. For tests. */
  claudeCommand?: string;
  /**
   * Asked to stop: when the last window left after its Mac's Miks quit, or
   * to restart (Restart daemon… from any window, this Mac's or another's,
   * which can't start one itself). Without it, neither is offered.
   */
  onStop?: (restart: boolean) => void;
}): Promise<Daemon> {
  // macOS caps socket paths at 104 bytes and quietly truncates longer ones.
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error(`The socket path is too long for macOS (over 103 bytes): ${socketPath}`);
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const workspaces = new Workspaces({ socketPath, command, claudeCommand });

  const saved = statePath ? readSavedState(statePath) : null;
  const restored = !!saved?.workspaces.some((w) => w.tabs.length > 0);
  if (saved && restored) workspaces.restore(saved);
  const persistence = statePath ? persist(workspaces, statePath) : null;

  const cwdPoll = setInterval(() => workspaces.pollCwds(), 2000);
  cwdPoll.unref();
  // Cheap (one ioctl per pane), so often enough that a tab says `top` about
  // when top appears.
  const foregroundPoll = setInterval(() => workspaces.pollForeground(), 500);
  foregroundPoll.unref();

  // Connected UIs.
  const sockets = new Set<WebSocket>();
  let stopWhenIdle = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://miks");

    if (req.method === "GET" && url.pathname === "/api/ping") {
      // How many UIs are connected, so one quitting can tell whether another
      // (the dev build beside Miks.app, say) still needs the daemon.
      return json(res, 200, { ok: true, pid: process.pid, clients: sockets.size, stopWhenIdle });
    }

    if (req.method === "POST" && url.pathname === "/api/restart") {
      if (!onStop) return json(res, 501, { message: "This daemon can't restart itself." });
      json(res, 200, { ok: true });
      setImmediate(() => onStop(true));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/running") {
      return json(res, 200, { running: workspaces.running() });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, workspaces.getState());
    }

    if (req.method === "POST" && url.pathname === "/api/keep") {
      const pane = url.searchParams.get("pane");
      return readText(req).then((command) => {
        if (pane) workspaces.keep(pane, command);
        json(res, 200, { ok: true });
      });
    }

    if (req.method === "POST" && url.pathname === "/api/drop") {
      const pane = workspaces.getPane(url.searchParams.get("pane") ?? "");
      const into = url.searchParams.get("into");
      return (async () => {
        const folder = into === "cwd" ? ((await pane?.cwd()) ?? os.homedir()) : fs.mkdtempSync(path.join(os.tmpdir(), "miks-drop-"));
        return receiveDrop(req, folder);
      })().then(
        (saved) => json(res, 200, { path: saved }),
        (error) => json(res, 500, { message: String(error?.message ?? error) }),
      );
    }

    if (req.method === "POST" && url.pathname === "/api/hook") {
      const pane = url.searchParams.get("pane");
      return readJson(req).then((payload) => {
        if (pane) workspaces.applyHook(pane, payload);
        json(res, 200, { ok: true });
      });
    }

    json(res, 404, { message: "Not found." });
  });

  //
  // UI connections.
  //

  const wss = new WebSocketServer({ server, path: "/ws" });

  let broadcastPending = false;
  workspaces.on("change", () => {
    // Coalesce bursts (a tab closing changes several things at once).
    if (broadcastPending) return;
    broadcastPending = true;
    setImmediate(() => {
      broadcastPending = false;
      const message = JSON.stringify({ type: "state", state: workspaces.getState() } satisfies DaemonMessage);
      for (const socket of sockets) socket.send(message);
    });
  });

  wss.on("connection", (socket) => {
    sockets.add(socket);

    const send = (message: DaemonMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    // This connection's viewer for each pane it has attached to.
    const viewers = new Map<string, PaneViewer>();

    socket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (message.type) {
        case "hello":
          return send({ type: "state", state: workspaces.getState() });
        case "createWorkspace":
          workspaces.createWorkspace(message);
          return;
        case "closeWorkspace":
          return workspaces.closeWorkspace(message.workspaceId);
        case "renameWorkspace":
          return workspaces.renameWorkspace(message.workspaceId, message.title);
        case "createTab":
          workspaces.newTab(message.workspaceId);
          return;
        case "moveWorkspace":
          return workspaces.moveWorkspace(message.workspaceId, message.index);
        case "moveTab":
          return workspaces.moveTab(message.tabId, message.index);
        case "stopWhenIdle":
          stopWhenIdle = message.value;
          return;
        case "appearance":
          return workspaces.setDark(message.dark);
        case "closeTab":
          return workspaces.closeTab(message.tabId);
        case "select":
          return workspaces.select(message.workspaceId, message.tabId);
        case "seen":
          return workspaces.markSeen(message.tabId);
        case "attach": {
          const pane = workspaces.getPane(message.tabId);
          if (!pane) return;

          const { tabId } = message;
          const previous = viewers.get(tabId);
          if (previous) pane.detach(previous);

          const viewer: PaneViewer = {
            snapshot: (data, cols, rows) => send({ type: "snapshot", tabId, data, cols, rows }),
            output: (data) => send({ type: "output", tabId, data }),
          };
          viewers.set(tabId, viewer);
          const { cols, rows } = message;
          pane.attach(viewer, cols && rows ? { cols, rows } : undefined);
          return;
        }
        case "detach": {
          const viewer = viewers.get(message.tabId);
          if (viewer) workspaces.getPane(message.tabId)?.detach(viewer);
          viewers.delete(message.tabId);
          return;
        }
        case "input":
          return workspaces.getPane(message.tabId)?.write(message.data);
        case "clear":
          return workspaces.getPane(message.tabId)?.clear();
        case "resize":
          return workspaces.getPane(message.tabId)?.resize(message.cols, message.rows);
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      for (const [tabId, viewer] of viewers) workspaces.getPane(tabId)?.detach(viewer);
      if (stopWhenIdle && sockets.size === 0) onStop?.(false);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o600);

  return {
    workspaces,
    restored,
    close: async () => {
      // Saved before the panes go: each one exiting removes its tab, and
      // that layout, emptied, is not the one to come back to.
      clearInterval(cwdPoll);
      clearInterval(foregroundPoll);
      await persistence?.final();
      workspaces.killAll();
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Keeps `state.json` current: shortly after any change, and every so often
 * for what changes no event announces (a shell cd'ing somewhere).
 */
function persist(workspaces: Workspaces, statePath: string) {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let writing = Promise.resolve();

  const write = (state: SavedState) => {
    const temporary = `${statePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, statePath);
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      writing = writing.then(async () => {
        const state = await workspaces.save();
        if (!stopped) write(state);
      });
    }, 1000);
  };

  workspaces.on("change", schedule);
  const interval = setInterval(schedule, 30_000);
  interval.unref();

  return {
    /** One last save, after which nothing more is written. */
    final: async () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      await writing;
      const state = await workspaces.save();
      stopped = true;
      write(state);
    },
  };
}

/**
 * Unpacks a file or folder dropped on a window on another Mac (a tar of it,
 * streamed through the SSH tunnel) into `folder`, under its own name, or
 * Finder's "name 2" when that's taken: never over anything. Returns where.
 */
async function receiveDrop(body: NodeJS.ReadableStream, folder: string): Promise<string> {
  // Beside where it ends up, so moving it there is a rename.
  const staging = fs.mkdtempSync(path.join(folder, ".miks-drop-"));
  try {
    const tar = spawn("tar", ["-xf", "-", "-C", staging], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    tar.stderr.on("data", (chunk) => (errors += chunk));
    body.pipe(tar.stdin);
    const code = await new Promise<number | null>((resolve) => tar.on("close", resolve));
    if (code !== 0) throw new Error(errors.trim() || `tar exited with ${code}.`);

    const [name, ...extra] = fs.readdirSync(staging);
    if (!name || extra.length > 0) throw new Error("Expected one file or folder.");
    const saved = freeName(folder, name);
    fs.renameSync(path.join(staging, name), saved);
    return saved;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** `name` in `folder`, or "name 2", "name 3"… (before any extension) if taken. */
function freeName(folder: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(folder, i === 1 ? name : `${stem} ${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function readSavedState(statePath: string): SavedState | null {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return saved?.version === 1 && Array.isArray(saved.workspaces) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * A socket file left behind by a daemon that died is removed; one that
 * something is still listening on means a daemon is already running.
 */
async function removeStaleSocket(socketPath: string) {
  if (!fs.existsSync(socketPath)) return;

  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

  if (alive) throw new Error(`A Miks daemon is already running at ${socketPath}.`);
  fs.unlinkSync(socketPath);
}

function json(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readText(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);

  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "null");
  } catch {
    return null;
  }
}
