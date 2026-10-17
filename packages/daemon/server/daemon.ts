import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, DaemonMessage } from "../shared/protocol.ts";
import type { PaneViewer } from "./Pane.ts";
import { Workspaces } from "./Workspaces.ts";

export type Daemon = {
  workspaces: Workspaces;
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
  command,
}: {
  socketPath: string;
  /** What each pane runs, instead of a login shell. For tests. */
  command?: string[];
}): Promise<Daemon> {
  // macOS caps socket paths at 104 bytes and quietly truncates longer ones.
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error(`The socket path is too long for macOS (over 103 bytes): ${socketPath}`);
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const workspaces = new Workspaces({ socketPath, command });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://miks");

    if (req.method === "GET" && url.pathname === "/api/ping") {
      return json(res, 200, { ok: true, pid: process.pid });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, workspaces.getState());
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
  const sockets = new Set<WebSocket>();

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
          workspaces.createTab(message.workspaceId);
          return;
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
        case "resize":
          return workspaces.getPane(message.tabId)?.resize(message.cols, message.rows);
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      for (const [tabId, viewer] of viewers) workspaces.getPane(tabId)?.detach(viewer);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o600);

  return {
    workspaces,
    close: async () => {
      workspaces.killAll();
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);

  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "null");
  } catch {
    return null;
  }
}
