# Anthropic Rate Limit Stats in Status Popover

**Goal:** Add a "Limits" tab to the OpenCode status popover showing real-time Anthropic API rate limit data (requests remaining, tokens remaining, reset timers) parsed from response headers on every successful LLM call.

**Feature branch:** feature/ratelimit-status

---

## Architecture

```
AI SDK streamText → finish-step (value.response.headers)
  → processor.ts extracts anthropic-ratelimit-* headers
  → RateLimit module (new, in-memory state + bus event)
  → SSE to frontend (auto-routed via GlobalBus)
  → event-reducer handles "ratelimit.updated"
  → State.ratelimit in global-sync store
  → StatusPopover new "Limits" tab with progress bars
```

---

## Phase 1: Backend — RateLimit Module

### Task 1.1 — Create RateLimit module

- [x] Create `packages/opencode/src/provider/ratelimit.ts`
  - Follow `SessionStatus` pattern (see `src/session/status.ts`)
  - Export `RateLimit` namespace with: `Info` zod schema, `Event` bus event, `parse()`, `get()`, `list()`
  - `Info` schema fields: `providerID`, `requests?`, `tokens?`, `inputTokens?`, `outputTokens?`, `time`
  - Each dimension: `{ limit: number, remaining: number, reset?: string }`
  - `parse(providerID, headers)`: check `anthropic-ratelimit-requests-limit` header; if absent return early; extract all `anthropic-ratelimit-*` headers; publish `BusEvent.define("ratelimit.updated", ...)` via `Bus.publish()`
  - In-memory state via `Instance.state()` keyed by providerID
  - Guard: `Number.isFinite()` on all parsed values
  - Conventions: single-word names, no `else`, no destructuring, const only, no `any`

### Task 1.2 — Hook processor.ts to capture response headers

- [x] Edit `packages/opencode/src/session/processor.ts`
  - Add import: `import { RateLimit } from "@/provider/ratelimit"`
  - In `"finish-step"` case (line 245), after `Session.updateMessage()` call, add:
    ```ts
    const hdrs = value.response?.headers
    if (hdrs) RateLimit.parse(input.model.providerID, hdrs)
    ```
  - Verify: `bun typecheck --cwd packages/opencode` exits 0

---

## Phase 2: Frontend — State + Event Handling

### Task 2.1 — Add ratelimit to State type

- [x] Edit `packages/app/src/context/global-sync/types.ts`
  - Add `RateLimitDimension`, `RateLimitTokenDimension`, `RateLimitInfo` types
  - Add `ratelimit: { [providerID: string]: RateLimitInfo }` to `State` type

### Task 2.2 — Initialize default state

- [x] Edit `packages/app/src/context/global-sync/child-store.ts`
  - Add `ratelimit: {}` to `createStore<State>({ ... })` initial object (after `lsp: []`)

### Task 2.3 — Handle ratelimit.updated event

- [x] Edit `packages/app/src/context/global-sync/event-reducer.ts`
  - Import `RateLimitInfo` from `./types`
  - Add case in `applyDirectoryEvent` switch (after `"lsp.updated"` case):
    ```ts
    case "ratelimit.updated": {
      const props = event.properties as RateLimitInfo
      input.setStore("ratelimit", props.providerID, reconcile(props))
      break
    }
    ```
  - Verify: `bun typecheck --cwd packages/app` exits 0

---

## Phase 3: UI — Limits Tab in Status Popover

### Task 3.1 — Add i18n strings

- [x] Edit `packages/app/src/i18n/en.ts`
  - Add near `status.popover.tab.*` entries:
    ```
    "status.popover.tab.limits": "Limits",
    "dialog.limits.empty": "No rate limit data yet",
    "dialog.limits.requests": "Requests / min",
    "dialog.limits.tokens": "Tokens / min",
    "dialog.limits.inputTokens": "Input tokens / min",
    "dialog.limits.outputTokens": "Output tokens / min",
    "dialog.limits.remaining": "remaining",
    "dialog.limits.reset": "resets in",
    ```

### Task 3.2 — Add Limits tab to StatusPopover

- [x] Edit `packages/app/src/components/status-popover.tsx`
  - Add computed signals: `limits` (Object.values of sync.data.ratelimit), `limitsCount`
  - Add `<Tabs.Trigger value="limits">` in `<Tabs.List>` after "plugins" trigger
  - Add `<Tabs.Content value="limits">`:
    - For each provider in `limits()`: show providerID label + per-dimension rows
    - Each row: label + "remaining / limit" text + inline progress bar div
    - Progress bar: `((limit - remaining) / limit) * 100`% width
    - Color: success < 70%, warning 70-90%, critical > 90% (use existing icon color classes)
    - Reset time: parse ISO 8601 string, show relative "in Xs" if future
    - Empty state: show `language.t("dialog.limits.empty")` centered
  - Verify: `bun typecheck --cwd packages/app` exits 0

---

## Final Verification Wave

### F1 — Type check backend

- [x] Run `bun typecheck --cwd packages/opencode` → exit 0

### F2 — Type check frontend

- [x] Run `bun typecheck --cwd packages/app` → exit 0

### F3 — Functional review

- [x] All 8 changed/created files reviewed line-by-line:
  - `packages/opencode/src/provider/ratelimit.ts`
  - `packages/opencode/src/session/processor.ts`
  - `packages/app/src/context/global-sync/types.ts`
  - `packages/app/src/context/global-sync/child-store.ts`
  - `packages/app/src/context/global-sync/event-reducer.ts`
  - `packages/app/src/components/status-popover.tsx`
  - `packages/app/src/i18n/en.ts`
- [x] No `any`, no `@ts-ignore`, no `else`, no destructuring
- [x] Graceful degradation: non-Anthropic providers → no errors, Limits tab shows empty state

### F4 — Regression check

- [x] Existing 4 popover tabs (Servers, MCP, LSP, Plugins) render without change
- [x] Existing token/cost tracking in session header still works
- [x] No new npm dependencies added
