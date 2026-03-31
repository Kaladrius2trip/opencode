# Fix Claude Code Auth for OpenCode Fork

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the built-in Anthropic auth plugin to properly handle Claude Code OAuth tokens, import Claude CLI credentials, handle 429 rate limits gracefully, and provide clear error messages.

**Architecture:** Improve the built-in `anthropic.ts` plugin (single file, 417 lines) by: (1) adding a `loadClaudeCliCredentials()` helper with caching, (2) adding a "Claude Code (import from CLI)" auth method using `method: "auto"`, (3) auto-importing Claude CLI creds on startup in the loader, (4) trying cached CLI creds before network refresh in `ensure()`, (5) fixing `retry-after-ms` support in `refresh()`, (6) improving error messages with the structured `log` logger.

**Tech Stack:** TypeScript, Effect.ts, OpenCode plugin system (`@opencode-ai/plugin`), Anthropic OAuth PKCE

---

## Problem Summary

1. User logs in with Claude Code token, immediately gets `429` on `https://console.anthropic.com/v1/oauth/token` during refresh
2. Error is opaque: `Token refresh failed: URL 429 { rate_limit_error }` — no actionable guidance
3. No support for `retry-after-ms` header (only `retry-after` in seconds at line 103)
4. No Claude CLI credential import — unlike `dotCipher/opencode-claude-bridge`
5. When token expires, always hits network even if Claude CLI has a fresh token locally

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/opencode/src/plugin/anthropic.ts` | All changes — single file, 417 lines |

## Key Context for Implementer

- **Target file:** `packages/opencode/src/plugin/anthropic.ts` — 417 lines
- **Logger:** uses `log` object from `Log.create({ service: "plugin.anthropic" })` at line 7. Use `log.info()`, `log.warn()`, `log.error()` with structured metadata objects
- **Auth method structure:** each method is `{ label, type, authorize? }` object in the `methods` array (lines 371-413). Currently 3 methods: "Claude Pro/Max" (line 373), "Create an API Key" (line 386), "Manually enter API Key" (line 410)
- **Auth flow for `type: "oauth"` methods:** `authorize()` returns `{ url, instructions, method: "auto"|"code", callback }`. For `method: "auto"`, the TUI shows the URL/instructions, then immediately calls `callback()` which returns `{ type: "success", refresh, access, expires }` or `{ type: "failed" }`. The `ProviderAuth.callback` then stores the result via `auth.set()`.
- **Token refresh:** `refresh()` function at line 76-140, tries both `claude.ai` and `console.anthropic.com` endpoints
- **Single-flight ensure:** `ensure()` at line 143-189, serializes concurrent refresh calls via `inflight` Map
- **Loader:** `async loader(getAuth, provider)` at line 277, receives `getAuth()` function and `sdk` via closure
- **Auth storage API:** `sdk.auth.set({ path: { id }, body: state })` (line 122)
- **Existing helpers:** `form()` (line 24), `sleep()` (line 28), `expired()` (line 32) — reuse these
- **Claude CLI creds path:** `~/.claude/.credentials.json` — contains `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType } }`
- **External plugin (reference only):** `/home/yevhenii/Projects/opencode-anthropic-auth/` — has battle-tested patterns
- **Build:** `bun run build -- --single`
- **Install:** copy `dist/opencode-linux-x64/bin/opencode` to `~/.opencode/bin/opencode`

---

### Task 1: Add Claude CLI Credential Reader with Cache

Add a helper function to read tokens from `~/.claude/.credentials.json` with a 30-second TTL cache to avoid filesystem reads on every API request.

**Files:**
- Modify: `packages/opencode/src/plugin/anthropic.ts:1-6` (imports), `:35-36` (after `expired()`)

- [ ] **Step 1: Add imports at the top of the file**

After line 4 (`import { Installation } from "../installation"`), add:

```typescript
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
```

- [ ] **Step 2: Add `loadClaudeCliCredentials()` with TTL cache after the `expired()` helper (after line 35)**

```typescript
let _cliCredsCache: { access: string; refresh: string; expires: number } | null = null
let _cliCredsCacheTime = 0
const CLI_CREDS_TTL = 30_000 // 30 seconds

function loadClaudeCliCredentials(): { access: string; refresh: string; expires: number } | null {
  if (_cliCredsCache && Date.now() - _cliCredsCacheTime < CLI_CREDS_TTL) return _cliCredsCache
  const credPath = process.env.CLAUDE_CREDENTIALS_PATH ?? path.join(os.homedir(), ".claude", ".credentials.json")
  try {
    if (!fs.existsSync(credPath)) return null
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"))
    const oauth = raw?.claudeAiOauth
    if (!oauth || typeof oauth.refreshToken !== "string") return null
    const expiresAt =
      typeof oauth.expiresAt === "number"
        ? oauth.expiresAt > 1e12
          ? oauth.expiresAt
          : oauth.expiresAt * 1000
        : Date.now()
    _cliCredsCache = {
      access: typeof oauth.accessToken === "string" ? oauth.accessToken : "",
      refresh: oauth.refreshToken,
      expires: expiresAt,
    }
    _cliCredsCacheTime = Date.now()
    return _cliCredsCache
  } catch {
    return null
  }
}
```

- [ ] **Step 3: Build and verify**

Run: `bun run build -- --single 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "feat: add Claude CLI credential reader with TTL cache"
```

---

### Task 2: Add "Claude Code (import from CLI)" Auth Method

Add a fourth auth method using `method: "auto"` so the TUI calls `callback()` immediately with no URL/code interaction needed.

**Files:**
- Modify: `packages/opencode/src/plugin/anthropic.ts` — the `methods` array (lines 371-413)

- [ ] **Step 1: Add the new method to the `methods` array**

After the "Manually enter API Key" entry (line 410-412), before the closing `]` of methods, add:

```typescript
        {
          label: "Claude Code (import from CLI)",
          type: "oauth" as const,
          authorize: async () => {
            return {
              url: "",
              instructions: "Importing credentials from Claude CLI...",
              method: "auto" as const,
              callback: async () => {
                const creds = loadClaudeCliCredentials()
                if (!creds || !creds.refresh) {
                  return { type: "failed" as const }
                }
                return {
                  type: "success" as const,
                  access: creds.access,
                  refresh: creds.refresh,
                  expires: creds.expires,
                }
              },
            }
          },
        },
```

**How this works:** The TUI `AutoMethod` component (dialog-provider.tsx:128) shows instructions, then immediately calls `ProviderAuth.callback()` which invokes `match.callback()`. Our callback reads the CLI creds and returns success/fail. On success, `ProviderAuth.callback` stores the tokens via `auth.set()` (auth.ts:217-226).

- [ ] **Step 2: Build and verify**

Run: `bun run build -- --single 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "feat: add Claude Code CLI import auth method"
```

---

### Task 3: Auto-Import Claude CLI Credentials in Loader

When the plugin loads and the stored token is missing or expired, automatically import from Claude CLI without user interaction.

**Files:**
- Modify: `packages/opencode/src/plugin/anthropic.ts:277-280` (loader function start)

- [ ] **Step 1: Restructure the loader to support auto-import**

Current code (lines 277-280):
```typescript
      async loader(getAuth, provider) {
        const id = (getAuth as typeof getAuth & { providerID?: string }).providerID ?? "anthropic"
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}
```

Replace with:
```typescript
      async loader(getAuth, provider) {
        const id = (getAuth as typeof getAuth & { providerID?: string }).providerID ?? "anthropic"
        let auth = await getAuth()

        // Auto-import Claude CLI credentials if no valid OAuth token exists
        if (auth.type !== "oauth" || !auth.access || (auth.expires ?? 0) < Date.now()) {
          const cliCreds = loadClaudeCliCredentials()
          if (cliCreds && cliCreds.refresh && cliCreds.expires > Date.now()) {
            log.info("auto-importing Claude CLI credentials", { expires: new Date(cliCreds.expires).toISOString() })
            await sdk.auth.set({
              path: { id },
              body: {
                type: "oauth" as const,
                access: cliCreds.access,
                refresh: cliCreds.refresh,
                expires: cliCreds.expires,
              },
            })
            auth = await getAuth()
          }
        }

        if (auth.type !== "oauth") return {}
```

**Key fix vs. previous revision:** Uses `let auth` instead of `const auth` and reassigns `auth = await getAuth()` after import. This way the line 280 check (`if (auth.type !== "oauth") return {}`) sees the updated auth state.

- [ ] **Step 2: Build and verify**

Run: `bun run build -- --single 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "feat: auto-import Claude CLI credentials on loader startup"
```

---

### Task 4: Try CLI Credentials Before Network Refresh

In `ensure()`, before hitting the network for token refresh, check if Claude CLI has a fresh token (uses cached read, <1ms).

**Files:**
- Modify: `packages/opencode/src/plugin/anthropic.ts:158-160` (ensure function, after early-return-if-valid)

- [ ] **Step 1: Add CLI credential fallback in ensure()**

After line 158 (`if (!force && auth.access && (auth.expires ?? 0) > Date.now()) return { access: auth.access }`), before line 160 (`const run = inflight.get(id)`), add:

```typescript
  // Try Claude CLI credentials before hitting the network (uses cached read)
  if (!force) {
    const cliCreds = loadClaudeCliCredentials()
    if (cliCreds && cliCreds.access && cliCreds.expires > Date.now() + 5 * 60 * 1000) {
      log.info("using fresh token from Claude CLI credentials file")
      await sdk.auth.set({
        path: { id },
        body: {
          type: "oauth" as const,
          access: cliCreds.access,
          refresh: cliCreds.refresh,
          expires: cliCreds.expires,
        },
      })
      return { access: cliCreds.access }
    }
  }
```

**Note:** The `!force` guard ensures that when 401 triggers a forced refresh (line 350-354), we still do a real network refresh rather than re-reading possibly stale CLI creds.

- [ ] **Step 2: Build and verify**

Run: `bun run build -- --single 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "fix: try Claude CLI credentials before network token refresh"
```

---

### Task 5: Fix `retry-after-ms` Header Support

The current 429 handler (line 102-106) only reads `retry-after` (seconds). Add `retry-after-ms` (milliseconds) support.

**Files:**
- Modify: `packages/opencode/src/plugin/anthropic.ts:102-106`

- [ ] **Step 1: Update 429 handling in `refresh()`**

Replace lines 102-106:
```typescript
        if (res.status === 429) {
          const after = res.headers.get("retry-after")
          const delay = after ? Math.min(Number(after) * 1000, 10_000) : RETRY_MS * 2 ** pass
          log.warn("anthropic token refresh rate limited", { url, pass, delay })
          await sleep(delay)
```

With:
```typescript
        if (res.status === 429) {
          const afterMs = res.headers.get("retry-after-ms")
          const afterSec = res.headers.get("retry-after")
          const delay = afterMs
            ? Math.min(Number(afterMs), 30_000)
            : afterSec
              ? Math.min(Number(afterSec) * 1000, 30_000)
              : RETRY_MS * 2 ** pass
          log.warn("OAuth token endpoint rate-limited", { url, pass, delay, retryAfterMs: afterMs, retryAfterSec: afterSec })
          await sleep(delay)
```

- [ ] **Step 2: Build and verify**

Run: `bun run build -- --single 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "fix: support retry-after-ms header in token refresh 429 handling"
```

---

### Task 6: Improve Error Messages

Make errors actionable and distinguish OAuth token endpoint errors from API rate limits. Use the structured `log` logger consistently.

**Files:**
- Modify: `packages/opencode/src/plugin/anthropic.ts:109,133-139`

- [ ] **Step 1: Update the non-429 error log at line 109**

Replace line 109:
```typescript
          log.warn("anthropic token refresh attempt failed", { url, status: res.status, body: text, pass })
```

With:
```typescript
          if (expired(text)) {
            log.error("OAuth refresh token expired or revoked", {
              url,
              status: res.status,
              hint: "Re-authenticate via 'Claude Code (import from CLI)' or 'Claude Pro/Max' auth method",
            })
          } else {
            log.warn("OAuth token refresh attempt failed", { url, status: res.status, body: text, pass })
          }
```

- [ ] **Step 2: Update the final throw at lines 133-139**

Replace:
```typescript
  log.error("anthropic token refresh failed", { error: err || "all refresh endpoints failed" })
  if (stale) {
    throw new Error(
      "Anthropic OAuth expired. Reconnect the provider with `opencode providers login --provider anthropic`.",
    )
  }
  throw new Error(`Token refresh failed: ${err}`)
```

With:
```typescript
  if (stale) {
    log.error("OAuth refresh token expired", { error: err })
    throw new Error(
      "Anthropic OAuth token expired or revoked. Re-authenticate: use 'Claude Code (import from CLI)' or run `opencode providers login --provider anthropic`.",
    )
  }
  log.error("OAuth token refresh failed after all retries", {
    error: err || "all endpoints failed",
    hint: "Rate limit on Anthropic's OAuth token endpoint (not the API). Try again shortly or re-import from Claude CLI.",
  })
  throw new Error(
    `OAuth token refresh failed after ${MAX_PASSES} attempts. ` +
      `Rate limited on Anthropic's OAuth token endpoint (not the API). ` +
      `Try again in a few minutes, or re-import credentials from Claude CLI.`,
  )
```

- [ ] **Step 3: Build and verify**

Run: `bun run build -- --single 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "fix: improve error messages for OAuth token refresh failures"
```

---

### Task 7: Build, Install, and Verify End-to-End

- [ ] **Step 1: Full build**

Run: `bun run build -- --single 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 2: Install**

```bash
HASH=$(~/.opencode/bin/opencode --version 2>/dev/null | grep -oP '\+\K[a-f0-9]+' || echo "unknown")
cp ~/.opencode/bin/opencode ~/.opencode/bin/opencode.backup-${HASH}
ls -t ~/.opencode/bin/opencode.backup-* 2>/dev/null | tail -n +4 | xargs rm -f
rm ~/.opencode/bin/opencode
cp packages/opencode/dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
~/.opencode/bin/opencode --version
```

- [ ] **Step 3: Test auth flow**

1. Clear existing auth: remove anthropic entry from `~/.local/share/opencode/auth.json`
2. Start opencode — should auto-import Claude CLI credentials from `~/.claude/.credentials.json`
3. Send a test message — should work without 429 errors
4. If token is expired, should try CLI creds first before network refresh

- [ ] **Step 4: Final commit if any last changes needed**

```bash
git add packages/opencode/src/plugin/anthropic.ts
git commit -m "feat: complete Claude Code auth improvements for fork"
```
