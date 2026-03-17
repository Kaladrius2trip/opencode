# Learnings

## 2026-03-16 Session: ses_308697fffffeuA3WNWMTLTCW6X

### Key patterns from codebase

- BusEvent.define() auto-registers in global registry → SSE auto-routes all events, no extra code needed
- SessionStatus pattern: BusEvent.define → Instance.state → publish on set → consumed via event-reducer
- processor.ts "finish-step" event: `value.response?.headers` is Record<string, string> | undefined (AI SDK v5)
- instance.state() pattern: factory fn passed to create per-project state, keyed by arbitrary keys
- Frontend event reducer: applyDirectoryEvent switch → setStore with reconcile
- child-store.ts has the createStore initial values — ALSO update here when adding State fields
- i18n: flat key pattern e.g. "status.popover.tab.mcp" for tab labels
- Worktree: /home/yevhenii/Projects/opencode-fork-ratelimit (branch: feature/ratelimit-status)
- github/index.ts has pre-existing LSP errors — unrelated, ignore

### Code conventions (mandatory)

- Single-word variable names (pid, cfg, err, hdrs, opts, dir)
- No `else` — early returns only
- No destructuring — use obj.a notation
- No `any` type
- No `@ts-ignore` in new code
- `const` over `let`
- Imports use @/ alias for src/

## 2026-03-16 Task: Create ratelimit.ts

### Implementation notes

- ratelimit.ts mirrors status.ts structure exactly: namespace → Info schema → Event → state → parse/get/list
- Bus.publish(Event.Updated, info) is fire-and-forget (no await), same as SessionStatus.set pattern
- num() helper defined inside parse() as closure over headers param — single arg `h: string`
- .meta({ ref: "RateLimit" }) on Info schema — matches status.ts pattern with .meta({ ref: "SessionStatus" })
- tsgo (TypeScript Go native compiler) is the typecheck tool — available via node_modules/.bin/tsgo after bun install
- Worktree needed `bun install` before typecheck could run (node_modules not shared between worktrees)
- Short var names used: lim, rem, rst (requests); tlim, trem, trst (tokens); irem, orem (input/output tokens)

## Frontend global-sync state wiring (ratelimit)

### Pattern for adding new event-driven state to global-sync
1. **types.ts**: Add local helper types (not exported), then export the main type. Add field to `State` type.
2. **child-store.ts**: Initialize the field in `createStore<State>({...})` with empty default (`{}` for maps, `[]` for arrays).
3. **event-reducer.ts**: Import the new type from `./types`, add `case "event.name":` in `applyDirectoryEvent` switch.

### Key observations
- `reconcile` is already imported in event-reducer.ts — reuse it for all store updates
- The `ratelimit` field uses `providerID` as the map key (same pattern as `mcp` uses `name`)
- `setStore("ratelimit", props.providerID, reconcile(props))` — SolidJS store path update with reconcile
- `lsp.updated` case just calls `input.loadLsp()` (no direct store write) — ratelimit is simpler, writes directly
- Typecheck: `bun typecheck --cwd packages/app` from repo root runs turbo across all 19 packages; `@opencode-ai/app` is the relevant one

- Added 'Limits' tab to the status popover displaying Anthropic rate limits via the global `sync` context in the SolidJS app.
- The `LimitRow` helper component dynamically builds standard dimension rows and renders progress bars using local state rather than needing exports.
- Integrated matching structure with existing `<Tabs.Content>` format for seamless UI.
