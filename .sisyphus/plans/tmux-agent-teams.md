# Tmux Agent Teams (via opentmux plugin)

**Goal:** Enable Claude Code-style agent teams where subagent sessions spawn as tmux split panes, providing real-time visibility into parallel agent work.

**Key finding:** The `opentmux` npm package (v1.5.7, https://github.com/AnganSamadder/opentmux) already implements this exact feature as an OpenCode plugin. The fork's plugin system, event bus, and `opencode attach` command are fully compatible.

**Approach:** Fork the opentmux repo, customize it for our needs, and load it as a local plugin via the fork's `file://` plugin path support (confirmed in `packages/opencode/src/plugin/index.ts` line 66).

---

## How opentmux works

1. Registers as an OpenCode plugin via `config.plugin` array
2. Listens for `session.created` events from the event bus
3. When a child session (has `parentID`) is created → spawns a tmux pane via `tmux split-window -h -d`
4. Pane runs `opencode attach <serverUrl> --session <sessionId>` to show live TUI of subagent
5. Polls session status via HTTP API → auto-closes panes when session completes/times out
6. Has spawn queue (serialized pane creation), zombie reaper (cleanup), layout management

---

## Phase 1 — Fork & Set Up opentmux as local plugin

### Task 1.1: Fork the opentmux repo

```bash
gh repo fork AnganSamadder/opentmux --clone --remote
```

Clone to a location alongside the opencode fork (e.g., `~/Projects/opentmux`).

**Verify:** Repo cloned, `src/index.ts` exists

### Task 1.2: Build the fork

```bash
cd ~/Projects/opentmux
bun install  # or npm install
bun run build  # or npm run build
```

**Verify:** Build succeeds, `dist/` or output directory is created

### Task 1.3: Configure as local plugin via file:// path

The fork's plugin system (line 66 of `packages/opencode/src/plugin/index.ts`) supports `file://` paths. Add to opencode config (`~/.config/opencode/config.json` or project `.opencode/config.json`):

```json
{
  "plugin": ["file:///home/yevhenii/Projects/opentmux/dist/index.js"]
}
```

Point to the built entry file. The plugin loader will `import()` it directly — no npm install needed.

**Verify:** `opencode` starts without plugin errors in logs

### Task 1.4: Configure opentmux settings

Create `~/.config/opencode/opentmux.json`:

```json
{
  "layout": "tiled",
  "auto_close": true,
  "reaper": {
    "enabled": true,
    "interval_ms": 5000,
    "idle_timeout_ms": 30000
  }
}
```

### Task 1.5: Test inside tmux

1. Start a tmux session: `tmux new -s opencode-test`
2. Launch opencode: `opencode`
3. Ask it to use the task tool (spawn a subagent) — e.g., "explore the codebase structure"
4. **Expected:** A new tmux pane appears showing the subagent's live output
5. **Expected:** Pane auto-closes when subagent completes

**Verify:** Pane appears, shows real-time agent output, closes on completion

---

## Phase 2 — Adapt the fork for our needs

Since we own the fork, we can customize opentmux directly rather than working around issues.

### Task 2.1: Verify plugin API compatibility

The fork's plugin system passes `PluginInput` with: `client`, `project`, `worktree`, `directory`, `serverUrl`, `$` (Bun shell).

opentmux's `init()` function expects this shape. Check `src/index.ts` in the opentmux fork — adapt if the `PluginInput` interface has changed since opentmux was written.

**If mismatched:** Update the fork's `src/index.ts` to match the current `@opencode-ai/plugin` `PluginInput` type.

### Task 2.2: Verify `opencode attach` command compatibility

opentmux spawns panes with: `opencode attach <serverUrl> --session <sessionId>`.

The fork has this at `packages/opencode/src/cli/cmd/tui/attach.ts`. Verify:

- Argument order matches what opentmux sends
- `--password` flag handling (opentmux may or may not pass it)
- SSE event streaming works for child sessions

**If mismatched:** Update the opentmux fork's `src/utils/tmux.ts` to match the fork's `attach` CLI signature.

### Task 2.3: Verify event shape compatibility

opentmux expects `session.created` events with specific fields (session ID, parentID, etc.).

Check `Bus.publish()` calls in the opencode fork's session creation code vs what opentmux's event handler expects.

**If mismatched:** Update the opentmux fork's event handler to match the fork's event shape.

### Task 2.4: Customize for our workflow

Potential customizations in the forked opentmux:

- Adjust default layout (tiled vs horizontal vs vertical)
- Tune reaper timing for our typical subagent durations
- Add any fork-specific event handling
- Strip features we don't need to simplify maintenance

---

## Phase 3 — Potential enhancements (optional, requires fork changes)

These would be nice-to-haves if the basic plugin works:

### 3.1: Add `OPENCODE_TMUX_TEAMS` flag

File: `packages/opencode/src/flag/flag.ts`

Add a flag to enable/disable tmux teams without editing config:

```ts
export const OPENCODE_TMUX_TEAMS = flag("OPENCODE_TMUX_TEAMS");
```

### 3.2: Add tmux config to experimental section

File: `packages/opencode/src/config/config.ts`

Add tmux options to the experimental config block alongside existing options like `disable_paste_summary`, `batch_tool`, etc.

### 3.3: Auto-detect tmux and suggest plugin

When running inside tmux (check `$TMUX` env), show a hint if opentmux isn't configured:
"Running inside tmux. Install opentmux for agent team panes: npm install -g opentmux"

---

## Decision points

1. **Phase 1: Fork + test first** — get the basic flow working with `file://` local plugin
2. **Phase 2: Adapt as needed** — since we own the fork, fix any compatibility issues directly
3. **Phase 3: Enhancements** — only after basic tmux pane spawning is validated
