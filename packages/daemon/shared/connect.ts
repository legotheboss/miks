import net from "net";
import { WebSocket } from "ws";

/**
 * Opens a WebSocket to the daemon. Not with a `ws+unix://` URL: `ws`
 * percent-encodes the socket path in those, so the space in "Application
 * Support" turns into an ENOENT.
 */
export function connectDaemon(socketPath: string): WebSocket {
  return new WebSocket("ws://miks/ws", { createConnection: () => net.connect(socketPath) });
}
