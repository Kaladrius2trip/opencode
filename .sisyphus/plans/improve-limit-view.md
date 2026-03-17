# Improve TUI Limit View UX

**Goal:** Enhance the Rate Limits section in `dialog-status.tsx` — better title, prominent reset timer, Claude Code branding, and cleaner visual hierarchy.

**Scope:** Single file change: `packages/opencode/src/cli/cmd/tui/component/dialog-status.tsx`  
**Optional:** `packages/opencode/src/provider/ratelimit.ts` (if we improve `fmtReset`)

---

## Current State (lines 183-248 of dialog-status.tsx)

```
Rate Limits
anthropic
  5h: 73% [###########.........] OK reset 2h30m
  7d: 25% [#####...............] OK reset 4.2d
  RPM: 45 / 50 remaining
  TPM: 78,000 / 80,000 remaining
```

**Problems:**

1. Title "Rate Limits" is generic — doesn't tell user what provider/product
2. Reset time buried at end of utilization line — hard to scan
3. `providerID` shown raw (e.g. "anthropic") — not user-friendly
4. No visual separation between utilization windows and RPM/TPM
5. Status labels (OK/WARN/DENIED) not prominent enough
6. No overall status summary at a glance

---

## Proposed Design

```
Claude Code Limits (anthropic)
  ● OK                    resets in 2h 30m

  5h   73%  [###########.........]
  7d   25%  [#####...............]

  RPM   45 / 50 remaining
  TPM  78k / 80k remaining
```

When status is warning/denied:

```
Claude Code Limits (anthropic)
  ⚠ WARNING               resets in 47m

  5h   89%  [#################...]
  7d   45%  [#########...........]

  RPM    5 / 50 remaining
  TPM  12k / 80k remaining
```

---

## Phase 1 — Refactor Display Logic

### Task 1.1 — Provider display name mapping

Add a helper to map raw `providerID` to a user-friendly display name.

**Location:** Top of `dialog-status.tsx`, near `fmtReset`

```ts
function label(id: string) {
  if (id === "anthropic" || id.startsWith("anthropic")) return "Claude Code"
  return id
}
```

**Rationale:** The Anthropic provider in this codebase uses the `claude-code-20250219` beta header — these ARE Claude Code limits. Other providers don't emit these headers, so the label is accurate.

### Task 1.2 — Improve `fmtReset` for human-friendly output

Current: `2h30m` → Proposed: `2h 30m` (add space for readability)

```ts
function fmtReset(epoch: number) {
  const diff = Math.ceil(epoch - Date.now() / 1000)
  if (diff <= 0) return ""
  if (diff < 3600) return `${Math.ceil(diff / 60)}m`
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    return `${h}h ${m.toString().padStart(2, "0")}m`
  }
  return `${(diff / 86400).toFixed(1)}d`
}
```

Only change: add a space between hours and minutes.

### Task 1.3 — Add compact number formatter for RPM/TPM

```ts
function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return n.toLocaleString()
}
```

---

## Phase 2 — Restructure the Rate Limits Section

### Task 2.1 — New section title with provider name

**Before:**

```tsx
<text fg={theme.text}>Rate Limits</text>
...
<text fg={theme.textMuted}>{info.providerID}</text>
```

**After:**

```tsx
<text fg={theme.text}>
  {label(info.providerID)} Limits <span style={{ fg: theme.textMuted }}>({info.providerID})</span>
</text>
```

- Shows "Claude Code Limits (anthropic)" as the header per provider
- Raw providerID kept in parentheses for technical reference
- Remove the separate generic "Rate Limits" header — each provider block is self-titled

### Task 2.2 — Prominent overall status + reset time (top of each provider block)

Add a hero line immediately after the title showing:

- Overall status indicator (● OK / ⚠ WARN / ✕ DENIED) with color
- Reset time right-aligned or after spacer

Derive overall status from the worse of window5h/window7d status values.

```tsx
// Compute worst status across windows
const worst = [info.utilization?.window5h, info.utilization?.window7d].filter(Boolean).reduce((acc, w) => {
  if (w.status === "denied") return "denied"
  if (w.status.includes("warning") && acc !== "denied") return "warning"
  return acc
}, "ok")

// Earliest reset
const reset = [info.utilization?.window5h?.reset, info.utilization?.window7d?.reset]
  .filter(Boolean)
  .reduce((a, b) => Math.min(a, b), Infinity)
```

Display:

```tsx
<text fg={theme.text}>
  {"  "}
  <span style={{ fg: worst === "denied" ? theme.error : worst === "warning" ? theme.warning : theme.success }}>
    {worst === "denied" ? "✕ DENIED" : worst === "warning" ? "⚠ WARNING" : "● OK"}
  </span>
  {"  "}
  {fmtReset(reset) && <span style={{ fg: theme.textMuted }}>resets in {fmtReset(reset)}</span>}
</text>
```

### Task 2.3 — Clean utilization window lines

Remove the inline status label and reset time from each window line (moved to hero line above).

**Before:**

```
  5h: 73% [###########.........] OK reset 2h30m
```

**After:**

```
  5h   73%  [###########.........]
```

Simpler, scannable. The status and reset are already shown prominently above.

### Task 2.4 — Compact RPM/TPM display

Use `compact()` for large numbers:

**Before:**

```
  RPM: 78,000 / 80,000 remaining
```

**After:**

```
  RPM  78k / 80k remaining
```

Keep full numbers for small values (< 1000).

---

## Phase 3 — Empty/Edge States

### Task 3.1 — No rate limit data

When `limits().length === 0`, the section is already hidden via `<Show when={limits().length > 0}>`. No change needed.

### Task 3.2 — Partial data (no utilization but has RPM/TPM)

Some providers might only send RPM/TPM headers without unified utilization. Handle gracefully:

- Skip the hero status line if no utilization data
- Still show RPM/TPM

### Task 3.3 — Non-Anthropic providers

The `label()` function falls through to showing raw providerID for non-Anthropic providers. The rest of the layout works generically.

---

## Verification

- [ ] `bun typecheck` from `packages/opencode` exits 0
- [ ] Visual inspection: status dialog renders correctly with mock data
- [ ] Edge case: no utilization data → no hero line, RPM/TPM still shown
- [ ] Edge case: denied status → red color, ✕ DENIED label
- [ ] Edge case: warning status → yellow color, ⚠ WARNING label
- [ ] No new dependencies
- [ ] Follows codebase style: single-word names, const only, no destructuring, no `any`
