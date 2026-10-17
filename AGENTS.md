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
  code changes need the daemon restarted, which ends every terminal: Miks →
  Restart daemon… in the app. The daemon names itself `miks-daemon`, so match
  that, not its script path (`pkill -f main.ts` misses it); for a scratch one,
  find it by its socket (`lsof -p <pid> | grep miks.sock`).
- Experiment against a scratch daemon, never the real one:
  `MIKS_HOME=/tmp/mk yarn dev`. Keep `MIKS_HOME` short; macOS caps socket
  paths at 104 bytes.
- `yarn install:app` builds Miks.app, signs it with the keychain's Developer
  ID (a stable signature is what keeps the permissions macOS grants Miks, and
  so everything in its terminals, across reinstalls), and swaps it into
  /Applications, relaunching it if it was running. It quits only the UI, found
  by bundle ID: the daemon runs on the same binary, so never `pkill -x Miks`.
  The running daemon keeps its old code until it next starts.
- Real state lives in `~/Library/Application Support/Miks` (socket,
  `daemon.log`, and Electron's profile in `UI/`). The dev build and Miks.app
  share it, and so share one daemon.
- The icon: `packages/app/icon/make-icon.sh` turns `source.png` (full-bleed
  square) into `icon.png` (dev Dock icon) and `Miks.icns`.
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
- The daemon runs on the app's own binary as plain Node
  (`ELECTRON_RUN_AS_NODE`): node-pty's prebuilt binary is Node-API, so no
  rebuild, nothing installed, and macOS attributes the daemon to Miks. It
  calls itself `miks-daemon` (`process.title`).
- Inside Miks.app, `node_modules/miks` is a stub package re-exporting
  `packages/daemon/shared`: Node won't strip types under node_modules, and the
  packager rewrites symlinks to absolute paths, which codesign rejects.
- `open` passes the calling shell's environment, so launching Miks.app from a
  Miks pane used to carry that pane's variables in.
- Third-party install scripts are off globally; `scripts/postinstall.ts` does
  the two Miks needs (node-pty's spawn-helper exec bit, Electron's download).
- Every size change is a SIGWINCH that makes full-screen programs (Claude Code,
  vim) redraw. Only the on-screen terminal sets a pane's size, after its WebGL
  renderer loads (the DOM renderer measures characters differently); hidden
  tabs attach without a size and adopt the pane's.
- Only attached clients answer terminal queries (the headless emulator's
  replies are dropped, as in VS Code), so each query gets one answer.
- Panes strip `CMUX_*`, `GHOSTTY_*`, `TERM_PROGRAM*`, `CLAUDECODE`,
  `ELECTRON_*` and inherited `MIKS_*` from the daemon's environment, or
  programs inside think they're in cmux or another Claude Code, Electron apps
  start as plain Node, and a Miks.app launched from a pane loads the dev
  server.

# Agent status

`packages/daemon/hooks/claude-hook.sh` is a Claude Code hook for every event;
it posts the hook JSON to `/api/hook?pane=$MIKS_PANE_ID` and is a no-op outside
Miks. Mapping in `Workspaces.applyHook`.

Interrupting a turn with Esc fires no hook. Claude Code's title does change:
◐/◑ while a turn runs, ✳ when it stops (verified live), so the spinner
stopping ends a `working` turn (`Workspaces.applyTitle`). Testing against a
real `claude` in a pane: start it in a trusted folder or it stops at the trust
prompt, and send a prompt's text and its Enter as separate writes, or Claude
Code takes the Enter as part of a paste.

# Style

Comments in Sentence case, ending with a period; UI text in Sentence case. No
useMemo/useCallback (React Compiler). Follow crosswing conventions
(`packages/crosswing`, and riot's `.claude/rules/crosswing.md`).
