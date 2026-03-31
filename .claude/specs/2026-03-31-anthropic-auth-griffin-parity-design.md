# Anthropic Auth Plugin — Griffin-Parity Redesign

**Date:** 2026-03-31
**Status:** Approved
**Reference:** https://github.com/griffinmartin/opencode-claude-auth

## Goal

Redesign the vendored Anthropic auth plugin to match the architecture and feature set of `griffinmartin/opencode-claude-auth`. The plugin becomes a thin credential bridge between Claude Code and OpenCode — no browser OAuth, no independent token management.

## Scope

### In Scope
- Modular rewrite of `packages/opencode/src/plugin/anthropic.ts` into `anthropic/` directory
- Full feature parity with Griffin's plugin (minus macOS Keychain, multi-account)
- Linux-only support
- Subprocess-based OAuth token refresh (stdin for security)

### Out of Scope
- macOS Keychain integration
- Multi-account switching
- Browser-based OAuth flow (removed — Claude Code handles this)
- Windows-specific auth.json paths

## Architecture

### Module Structure

```
packages/opencode/src/plugin/anthropic/
├── index.ts          # Plugin entry — auth loader, 2 methods (CLI auto + API key)
├── credentials.ts    # Read ~/.claude/.credentials.json, 30s TTL cache, write-back
├── refresh.ts        # OAuth refresh via subprocess (stdin), CLI fallback
├── transforms.ts     # mcp_ prefix add/strip, SSE stream buffering, system prompt rewrite
├── betas.ts          # Beta flags, per-model overrides, long-context error handling
├── model-config.ts   # Model config, CLI version string, billing header
├── logger.ts         # CLAUDE_AUTH_DEBUG logging with secret redaction
└── fetch.ts          # Custom fetch — compose all above, retry logic, 401 handling
```

### Removed from Current Implementation
- `authorize()` — no browser OAuth
- `exchange()` — no code-to-token exchange
- PKCE generation (`@openauthjs/openauth/pkce` dependency)
- "Claude Pro/Max (browser)" auth method
- Layer 2 in-process network refresh (subprocess replaces it)
- Dual token URL helpers (`tokenUrl("max")`, `tokenUrl("console")`) — single endpoint

### Kept from Current Implementation
- CLI credential reading + 30s TTL cache
- CLI force refresh fallback (`claude -p . --model haiku`)
- Custom fetch interceptor structure
- "API Key" fallback method
- Fallthrough behavior (no creds -> plugin disables)
- System prompt rewrite (`OpenCode` -> `Claude Code`)
- `experimental.chat.system.transform` hook
- `?beta=true` query parameter on `/v1/messages`
- Single-flight `inflight` Map for concurrent refresh serialization
- `accountId` and `enterpriseUrl` passthrough on token refresh

### Added from Griffin's Plugin
- Subprocess OAuth refresh via stdin
- SSE stream buffering at event boundaries
- `mcp_` prefix stripping from API responses (currently only adds, doesn't strip)
- Progressive long-context beta exclusion on 400/429
- auth.json background sync (startup + every 5min)
- `CLAUDE_AUTH_DEBUG` logging with secret redaction
- Per-model beta flag overrides (e.g., `effort-*` for 4-6 models)
- `enable1mContext` config support via env var `ANTHROPIC_ENABLE_1M_CONTEXT`

## Module Details

### index.ts — Plugin Entry

Registers `AnthropicAuthPlugin` with:
- `provider: "anthropic"`
- Two auth methods:
  1. "Claude Code (auto)" — reads CLI credentials, zero user interaction
  2. "API Key" — manual entry fallback
- `loader()` — sets model costs to 0, returns custom fetch, starts auth.json sync timer
- `experimental.chat.system.transform` hook — prepends Claude Code identity to system prompt

Single-flight `inflight` Map lives here (or in `fetch.ts`) to serialize concurrent refresh attempts. Same pattern as current `ensure()` function.

### credentials.ts — Credential Management

- **Source:** `~/.claude/.credentials.json` (or `$CLAUDE_CREDENTIALS_PATH`)
- **Cache:** In-memory, 30-second TTL
- **Parsing:** Handles `claudeAiOauth` wrapper and direct `accessToken/refreshToken/expiresAt` field formats. Skips MCP-only entries (containing only `mcpOAuth`).
- **Expiry normalization:** `expiresAt > 1e12` treated as milliseconds, otherwise multiplied by 1000
- **Expiry check:** Token considered stale if within 60 seconds of expiry
- **Write-back:** After refresh, writes new tokens back to credentials file
- **auth.json sync:** Uses `sdk.auth.set()` (the existing Auth service) to persist tokens — NOT direct file writes. Sync on startup and via `setInterval` every 5 minutes. Preserves `accountId` and `enterpriseUrl` fields through sync.

### refresh.ts — Token Refresh

Two-tier strategy:

**Tier 1 — Subprocess OAuth refresh:**

Spawns a Node/Bun subprocess that performs the OAuth refresh. The subprocess:
1. Reads refresh token from **stdin** (avoids exposure in `ps` output)
2. POSTs to `https://claude.ai/v1/oauth/token` with:
   - `client_id: 9d1c250a-e61b-44d9-88ed-5944d1962f5e`
   - `grant_type: refresh_token`
   - `refresh_token: <from stdin>`
3. Writes JSON result to **stdout**: `{"access_token": "...", "refresh_token": "...", "expires_in": 3600}`
4. On error, writes JSON to **stderr**: `{"error": "...", "status": 429, "retry_after_ms": 1000}`

**Implementation:** The subprocess script is embedded as a string constant in `refresh.ts` and passed to `child_process.spawn` via `node -e "<script>"` (or `bun -e`). The script is ~20 lines: read stdin, POST, write stdout. This matches Griffin's approach.

**Retry logic:**
- Handles `retry-after-ms` and `retry-after` headers (parsed from subprocess stderr JSON)
- Exponential backoff: base 1200ms, max 4 attempts
- Respects 30s cap on any single delay

**Tier 2 — Force CLI refresh (fallback):**
- Run `claude -p . --model haiku` (consumes Haiku tokens)
- Invalidate credential cache
- Re-read credentials file
- Retry up to 2 times

**Note on dual endpoints:** The current implementation tries both `claude.ai/oauth/token` and `console.anthropic.com/oauth/token`. Griffin's only uses `claude.ai/v1/oauth/token`. We adopt Griffin's single-endpoint approach. The `/v1/` path prefix is intentional — Griffin's plugin uses this path. If it fails, Tier 2 (CLI fallback) handles recovery.

### transforms.ts — Request/Response Transformation

**Request transform (`rewriteRequest`):**
- Add `mcp_` prefix to tool names in `tools` array
- Add `mcp_` prefix to tool names in `tool_use` content blocks within `messages` array
- System prompt rewrite: replace `SYSTEM_REPLACE_FROM` with `SYSTEM_REPLACE_TO` in system text blocks

**Response transform — SSE stream buffering (`wrapResponse`):**

SSE events are delimited by double newline (`\n\n`). The current implementation applies regex on arbitrary chunk boundaries, which can split an event mid-field and corrupt tool name replacement.

New approach:
1. Accumulate incoming chunks into a buffer
2. On each chunk arrival, scan buffer for complete events (terminated by `\n\n`)
3. For each complete event: apply `mcp_` prefix stripping via regex `"name"\s*:\s*"mcp_([^"]+)"` → `"name": "$1"`
4. Enqueue transformed events, keep remainder in buffer
5. On stream end: flush any remaining buffer content (partial event edge case)

**Non-streaming responses:** For non-SSE responses (e.g., error JSON), apply the same regex directly on the response body.

**Memory safety:** No explicit buffer size limit — SSE events from Anthropic API are bounded by the response token limit. Individual events are typically <100KB.

### betas.ts — Beta Flag Management

**Base betas (always included):**
```
claude-code-20250219
oauth-2025-04-20
interleaved-thinking-2025-05-14
prompt-caching-scope-2026-01-05
context-management-2025-06-27
adaptive-thinking-2026-01-28
```

**Per-model overrides:**
- Models with `4-6` in ID: add `effort-2025-11-24`

**Long-context betas (opt-in):**
```
context-1m-2025-08-07
interleaved-thinking-2025-05-14
```

Enabled via `ANTHROPIC_ENABLE_1M_CONTEXT=true` environment variable. No config schema change required — env var only, matching Griffin's approach.

**Progressive exclusion algorithm:**
1. Request fails with 400 or 429
2. Check error body for long-context indicators: strings like `"context"`, `"1m"`, `"token limit"`, or `"too many tokens"`
3. If match: remove the first long-context beta from the list, rebuild `anthropic-beta` header, retry the request
4. If second failure with same pattern: remove remaining long-context beta, retry once more
5. Maximum 2 retries for long-context exclusion (separate from the general 429 retry)
6. If still failing after exclusion: return the error to caller

**Merge function:** Combines base betas + per-model betas + existing header betas, deduplicating via Set (current `merge()` function preserved).

### model-config.ts — Model Configuration

- **CLI version detection:** Run `claude --version` once, cache result. Fallback: `"2.1.87"` (matching current implementation, not `2.1.80`)
- **User-agent construction:** `claude-cli/{version} (external, cli)`
- **Billing header construction:** `x-anthropic-billing-header` with CLI version and model info (format: JSON with `cli_version` and `model` fields, matching Griffin's approach)
- **Model-to-beta mapping:** Exported function `getBetasForModel(modelId: string): string[]` used by `betas.ts`

**Boundary with betas.ts:** `model-config.ts` owns the mapping data (which model gets which extra betas). `betas.ts` owns the merge logic and progressive exclusion algorithm.

### logger.ts — Debug Logging

- Enabled via `CLAUDE_AUTH_DEBUG=1` environment variable
- When disabled: all log calls are no-ops (zero overhead)
- **Output:** Structured JSON to stderr (avoids mixing with stdout/SSE data)
- **Redaction rules:** Fields named `access_token`, `refresh_token`, `accessToken`, `refreshToken`, `key`, `apiKey`, `authorization` are replaced with `"[REDACTED]"`. Applied recursively to nested objects.
- **Log categories:** `cred.read`, `cred.write`, `refresh.start`, `refresh.success`, `refresh.fail`, `fetch.request`, `fetch.response`, `fetch.error`, `sync.auth_json`
- Falls back to current `Log.create({ service: "plugin.anthropic" })` for non-debug logging (errors, warnings)

### fetch.ts — Custom Fetch Interceptor

**Flow:**
```
Request
  -> get cached creds (credentials.ts)
  -> within 60s of expiry? -> refresh (refresh.ts: Tier 1 -> Tier 2)
  -> set headers:
     - Authorization: Bearer {token}
     - anthropic-beta: {model-aware flags} (betas.ts)
     - user-agent: claude-cli/{version} (external, cli) (model-config.ts)
     - x-app: cli
     - x-anthropic-billing-header: {billing info} (model-config.ts)
     - Remove x-api-key header
  -> add ?beta=true to /v1/messages URL
  -> transform body: add mcp_ prefix + system rewrite (transforms.ts)
  -> send request
  -> 429/529? -> exponential backoff + retry (respect retry-after/retry-after-ms)
  -> 400/429 long-context? -> progressive beta exclusion + retry (betas.ts)
  -> 401? -> force refresh via ensure() with force=true, retry once
  -> transform response: SSE buffer + strip mcp_ prefix (transforms.ts)
  -> return
```

**Concurrency control:** The `ensure()` function with `inflight` Map (from current implementation) serializes concurrent refresh attempts. Multiple simultaneous 401s result in one refresh, others wait and re-read the result.

## Auth Methods

### Method 1: "Claude Code (auto)"
- Type: `oauth`
- Flow: Read `~/.claude/.credentials.json` -> validate -> store as OpenCode OAuth via `sdk.auth.set()`
- No user interaction required
- Falls through silently if Claude Code not installed or credentials file missing
- On expired/missing token: attempts `refreshViaClaudeCli()` before failing

### Method 2: "API Key"
- Type: `api`
- Flow: User manually enters Anthropic API key
- Fallback for users without Claude Code

## Fallthrough Behavior

If credentials are not OAuth-based (API key auth) or entirely unavailable:
- Auth loader returns `{}` (empty)
- OpenCode falls through to standard API key auth
- Plugin effectively disables itself
- No errors, no warnings — silent fallthrough

## Constants

```
OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
CREDENTIAL_CACHE_TTL = 30_000 (ms)
TOKEN_EXPIRY_BUFFER = 60 (seconds)
AUTH_JSON_SYNC_INTERVAL = 300_000 (5 minutes)
DEFAULT_CLI_VERSION = "2.1.87"
RETRY_BASE_MS = 1200
MAX_REFRESH_ATTEMPTS = 4
MAX_CLI_REFRESH_RETRIES = 2
MAX_RETRY_DELAY_MS = 30_000
```

## Testing

- Unit tests for each module (credentials parsing, beta flag logic, transforms, SSE buffering)
- Integration test for subprocess refresh flow (mock stdin/stdout)
- Test SSE stream buffering with split chunks across event boundaries
- Test progressive beta exclusion on simulated long-context errors
- Existing test file at `packages/opencode/test/plugin/anthropic.test.ts` to be updated/split per module
- Verify `accountId` and `enterpriseUrl` passthrough in refresh cycle

## Migration

1. Current `anthropic.ts` is deleted
2. New `anthropic/` directory created with 8 modules
3. Import in `packages/opencode/src/plugin/index.ts` updated from `./anthropic` to `./anthropic/index`
4. `@openauthjs/openauth/pkce` dependency can be removed if no other file uses it
5. No changes to plugin interface — same `AuthHook` contract
6. Existing tests updated to reflect new module structure
