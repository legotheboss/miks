Welcome! This repo is **Miks**: a terminal app for running many coding-agent
sessions at once. Workspaces in a sidebar, tabs in each, and each workspace's
agent status (working, needs you, done) at a glance. Nothing else, on purpose:
it exists because cmux grew far past that.

# Architecture

- `packages/daemon` (npm name `miks`): owns every PTY. Each pane is a
  `node-pty` process plus an `@xterm/headless` emulator fed every byte; a
  client attaching gets the emulator's screen serialized as VT sequences
  (`@xterm/addon-serialize`), then the live stream from exactly that point.
  Serves a WebSocket (`/ws`) and a small HTTP API on a Unix socket, never TCP:
  anything that can connect can type into your shells. Wire contract:
  `shared/protocol.ts`.
- `packages/ui`: a crosswing React app (xterm.js + WebGL). Talks to the daemon
  only through `window.miks`, the Electron preload bridge.
- `packages/app`: the Electron shell. A window, the menu (accelerators are how
  ⌘T etc. beat the terminal to the keystroke), and a pipe from the renderer to
  the daemon socket. Starts the daemon detached if nothing is listening.
- `packages/crosswing`: wings-synced shared UI code (`.wings`); check
  `wings sync miks --dry-run` before committing, drift should be 0.

The point of the split: **quitting or reloading the UI never touches a
session**. Only restarting the daemon does, and that kills every terminal; say
so before doing it to the real one.

# Running

- `yarn dev`: Vite with hot reload inside Electron. UI edits hot-reload,
  `packages/app` edits restart Electron, neither restarts the daemon. Daemon
  code changes need the daemon restarted (`pkill -f "daemon/server/main.ts
  serve"`; the app starts a fresh one on its next connect or reload).
- Experiment against a scratch daemon, never the real one:
  `MIKS_HOME=/tmp/mk yarn dev`. Keep `MIKS_HOME` short; macOS caps socket
  paths at 104 bytes.
- Real state lives in `~/Library/Application Support/Miks` (socket,
  `daemon.log`).
- `node scripts/devtools.ts screenshot out.png` / `eval '<js>'` drive the
  running dev app over its DevTools port (2739): how to check UI work without
  screen-recording permission. `curl --unix-socket <sock> http://miks/api/state`
  shows the daemon's view. `window.miks.send(JSON.stringify(msg))` in an eval
  sends any protocol message, e.g. typing into a pane.

# Checks

`yarn test` runs tsc (root, daemon, app), oxlint, and vitest.
`packages/daemon/server/daemon.test.ts` covers the reattach guarantees (screen
fidelity, alternate screen, no lost or repeated output mid-attach, no stray
resizes); keep it passing.

# Gotchas, verified

- The daemon and Electron main run TypeScript straight from source (Node 24 /
  Electron 44 type stripping): use `.ts` import extensions in the daemon,
  `import type` for types (`verbatimModuleSyntax` enforces it), no enums.
- The daemon runs on the system Node, not Electron's, so node-pty's prebuilt
  binary works without an Electron rebuild.
- Third-party install scripts are off globally; `scripts/postinstall.ts` does
  the two Miks needs (node-pty's spawn-helper exec bit, Electron's download).
- Every size change is a SIGWINCH that makes full-screen programs (Claude Code,
  vim) redraw. Only the on-screen terminal sets a pane's size, after its WebGL
  renderer loads (the DOM renderer measures characters differently); hidden
  tabs attach without a size and adopt the pane's.
- Only attached clients answer terminal queries (the headless emulator's
  replies are dropped, as in VS Code), so each query gets one answer.
- Panes strip `CMUX_*`, `GHOSTTY_*`, `TERM_PROGRAM*` and `CLAUDECODE` from the
  launching environment, or programs inside think they're running in cmux, or
  inside another Claude Code.

# Agent status

`packages/daemon/hooks/claude-hook.sh` is a Claude Code hook for every event;
it posts the hook JSON to `/api/hook?pane=$MIKS_PANE_ID` and is a no-op outside
Miks. Mapping in `Workspaces.applyHook`.

# Style

Comments in Sentence case, ending with a period; UI text in Sentence case. No
useMemo/useCallback (React Compiler). Follow crosswing conventions
(`packages/crosswing`, and riot's `.claude/rules/crosswing.md`).
