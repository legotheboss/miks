import headless from "@xterm/headless";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectDaemon } from "../shared/connect.ts";
import type { ClientMessage, DaemonMessage, DaemonState } from "../shared/protocol.ts";
import { type Daemon, serve } from "./daemon.ts";

const { Terminal } = headless;

// A shell with no rc files, so the screen is predictable.
const COMMAND = ["/bin/bash", "--norc", "--noprofile"];

let home: string;
let daemon: Daemon;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
  daemon = await serve({ socketPath: path.join(home, "miks.sock"), command: COMMAND });
});

afterEach(async () => {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("a new client sees exactly the screen the last one left, plus what happened since", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 80, rows: 24 });
  first.send({ type: "input", tabId, data: "PS1='$ '; printf '\\033[31mred\\033[0m\\n'; echo first-$((1+1))\n" });
  await first.waitForOutput(tabId, "first-2\r\n");
  first.close();

  // Output while nobody's watching still lands on the screen.
  daemon.workspaces.getPane(tabId)!.write("echo while-$((1+1))-away\n");
  await waitFor(() => paneText(tabId).then((text) => text.includes("while-2-away\n")));

  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId, cols: 80, rows: 24 });
  const screen = await second.screen(tabId);

  expect(screen.text).toContain("first-2");
  expect(screen.text).toContain("while-2-away");
  // Colors survive, since the snapshot is VT sequences rather than text.
  expect(second.snapshotFor(tabId)).toMatch(/\x1b\[31mred/);
  second.close();
});

test("a full-screen program comes back on the alternate screen", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 80, rows: 24 });
  // Switch to the alternate screen, draw at a position, and leave the shell
  // blocked so nothing else prints.
  first.send({ type: "input", tabId, data: "printf '\\033[?1049h\\033[5;10HFULL%sSCREEN' ' '; read\n" });
  await first.waitForOutput(tabId, "FULL SCREEN");
  first.close();

  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId, cols: 80, rows: 24 });
  const screen = await second.screen(tabId);

  expect(screen.terminal.buffer.active.type).toBe("alternate");
  expect(screen.lines[4].slice(9, 20)).toBe("FULL SCREEN");
  second.close();
});

test("attaching mid-stream neither drops nor repeats output", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const pane = daemon.workspaces.getPane(tabId)!;

  pane.write("PS1=''; for i in $(seq 1 20000); do echo line$i; done; echo ALL$((1))DONE\n");

  // Attach while the loop is still printing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const client = await connect();
  await client.state();
  client.send({ type: "attach", tabId, cols: 80, rows: 24 });
  await client.waitForOutput(tabId, "ALL1DONE\r\n");

  const screen = await client.screen(tabId);
  const numbers = screen.lines
    .map((line) => line.match(/^line(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);

  // Every line the snapshot didn't already hold arrived exactly once, in order.
  expect(numbers.at(-1)).toBe(20000);
  for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1] + 1);
  expect(client.snapshotFor(tabId)).not.toContain("ALL1DONE");
  client.close();
});

test("attaching without a size leaves the pane alone and reports its size", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 100, rows: 30 });
  // A trap shows whether the shell ever gets a SIGWINCH from here on.
  first.send({ type: "input", tabId, data: "trap 'echo WINCH-$((1+1))' WINCH; echo ready-$((1+1))\n" });
  await first.waitForOutput(tabId, "ready-2\r\n");
  first.close();

  // A tab that isn't on screen attaches without a size.
  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId });
  const snapshot = await second.snapshotMessage(tabId);
  expect([snapshot.cols, snapshot.rows]).toEqual([100, 30]);

  daemon.workspaces.getPane(tabId)!.write("echo after-$((1+1))\n");
  await second.waitForOutput(tabId, "after-2\r\n");
  expect(await paneText(tabId, 100, 30)).not.toContain("WINCH-2");
  second.close();
});

test("hooks drive the agent status", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const status = () => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.status;

  await postHook(tabId, { hook_event_name: "UserPromptSubmit" });
  expect(status()).toBe("working");

  await postHook(tabId, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" });
  expect(status()).toBe("waiting");

  await postHook(tabId, { hook_event_name: "PostToolUse" });
  expect(status()).toBe("working");

  await postHook(tabId, { hook_event_name: "Stop" });
  expect(status()).toBe("done");

  // The idle reminder after a finished turn doesn't turn `done` into `waiting`.
  await postHook(tabId, { hook_event_name: "Notification", notification_type: "idle_prompt" });
  expect(status()).toBe("done");

  daemon.workspaces.select(daemon.workspaces.getState().workspaces[0].id, tabId);
  expect(status()).toBe("idle");

  await postHook(tabId, { hook_event_name: "SessionEnd" });
  expect(status()).toBeUndefined();
});

test("the hook script posts to the daemon from inside a pane", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const script = path.resolve(import.meta.dirname, "../hooks/claude-hook.sh");

  // What Claude Code does: run the hook with the event's JSON on stdin, in
  // the pane's environment.
  daemon.workspaces.getPane(tabId)!.write(`echo '{"hook_event_name":"UserPromptSubmit"}' | ${script}\n`);

  await waitFor(async () => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.status === "working");
});

//
// Helpers.
//

function activeTab(state: DaemonState): string {
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)!;
  return workspace.activeTabId!;
}

/** The pane's own screen, read the same way a client would. */
async function paneText(tabId: string, cols = 80, rows = 24): Promise<string> {
  const client = await connect();
  await client.state();
  client.send({ type: "attach", tabId, cols, rows });
  const screen = await client.screen(tabId);
  client.close();
  return screen.text;
}

async function postHook(tabId: string, payload: any) {
  const http = await import("http");
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: path.join(home, "miks.sock"),
        path: `/api/hook?pane=${tabId}`,
        method: "POST",
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A test client that rebuilds each pane's screen the way the UI does: write
 * the snapshot into a fresh terminal, then every `output` after it.
 */
async function connect() {
  const socket = connectDaemon(path.join(home, "miks.sock"));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const messages: DaemonMessage[] = [];
  const listeners = new Set<() => void>();
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()));
    for (const listener of listeners) listener();
  });

  const until = <T>(find: () => T | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the daemon.")), 5000);
      const check = () => {
        const found = find();
        if (found === undefined) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      listeners.add(check);
      check();
    });

  const streamFor = (tabId: string) => {
    const start = messages.findIndex((m) => m.type === "snapshot" && m.tabId === tabId);
    if (start === -1) return undefined;
    return messages
      .slice(start)
      .filter((m) => (m.type === "snapshot" || m.type === "output") && m.tabId === tabId)
      .map((m) => (m as { data: string }).data)
      .join("");
  };

  return {
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    state: async () => {
      socket.send(JSON.stringify({ type: "hello" } satisfies ClientMessage));
      const message = await until(() => messages.findLast((m) => m.type === "state"));
      return message.state;
    },
    snapshotMessage: (tabId: string) =>
      until(() => messages.find((m) => m.type === "snapshot" && m.tabId === tabId) as
        | Extract<DaemonMessage, { type: "snapshot" }>
        | undefined),
    snapshotFor: (tabId: string) =>
      (messages.find((m) => m.type === "snapshot" && m.tabId === tabId) as { data: string } | undefined)?.data,
    waitForOutput: (tabId: string, text: string) =>
      until(() => {
        // The shell echoes what we type, so tests wait for text only the
        // command's output contains (`$((1+1))` prints `2`).
        const stream = streamFor(tabId) ?? "";
        return stream.includes(text) ? true : undefined;
      }),
    screen: async (tabId: string) => {
      const stream = await until(() => streamFor(tabId));
      const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true });
      await new Promise<void>((resolve) => terminal.write(stream, resolve));

      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      // On the alternate screen, rows are indexed from the top of the screen.
      const first = buffer.type === "alternate" ? buffer.baseY : 0;
      for (let i = first; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");

      return { terminal, lines, text: lines.join("\n") + "\n" };
    },
  };
}
