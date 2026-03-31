# Anthropic Auth Plugin — Griffin-Parity Modular Rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the vendored Anthropic auth plugin as a modular directory matching griffinmartin/opencode-claude-auth architecture — thin credential bridge, subprocess refresh, SSE buffering, debug logging.

**Architecture:** Split monolithic `anthropic.ts` (579 lines) into 8 focused modules under `anthropic/` directory. Remove browser OAuth flow entirely. Add subprocess-based token refresh, SSE stream buffering, progressive beta exclusion, and debug logging.

**Tech Stack:** TypeScript, Bun (runtime + test), `node:child_process` for subprocess refresh, `node:fs` for credentials file I/O.

**Spec:** `.claude/specs/2026-03-31-anthropic-auth-griffin-parity-design.md`

---

## File Map

### Create (new files)
- `packages/opencode/src/plugin/anthropic/index.ts` — plugin entry, auth methods, system transform hook
- `packages/opencode/src/plugin/anthropic/credentials.ts` — credential reading, cache, write-back, auth.json sync
- `packages/opencode/src/plugin/anthropic/refresh.ts` — subprocess OAuth refresh + CLI fallback
- `packages/opencode/src/plugin/anthropic/transforms.ts` — mcp_ prefix, SSE buffering, system prompt rewrite
- `packages/opencode/src/plugin/anthropic/betas.ts` — beta flags, merge, progressive exclusion
- `packages/opencode/src/plugin/anthropic/model-config.ts` — CLI version, user-agent, billing header
- `packages/opencode/src/plugin/anthropic/logger.ts` — debug logging with redaction
- `packages/opencode/src/plugin/anthropic/fetch.ts` — custom fetch interceptor composing all modules

### Modify (existing files)
- `packages/opencode/src/plugin/index.ts:11` — update import path
- `packages/opencode/test/plugin/anthropic.test.ts` — update import, rewrite tests for new architecture

### Delete
- `packages/opencode/src/plugin/anthropic.ts` — replaced by `anthropic/` directory

---

## Task 1: Logger Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/logger.ts`

- [ ] **Step 1: Create logger.ts**

```typescript
import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.anthropic" })

const DEBUG = process.env.CLAUDE_AUTH_DEBUG === "1"

const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "key",
  "apiKey",
  "authorization",
])

function redact(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(redact)
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v)
  }
  return result
}

function debugLog(category: string, message: string, data?: Record<string, unknown>) {
  if (!DEBUG) return
  const entry = {
    ts: new Date().toISOString(),
    cat: category,
    msg: message,
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  }
  process.stderr.write(JSON.stringify(entry) + "\n")
}

export const logger = {
  debug: debugLog,
  info: (msg: string, data?: Record<string, unknown>) => log.info(msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log.warn(msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log.error(msg, data),
}
```

- [ ] **Step 2: Verify file compiles**

Run: `cd packages/opencode && bunx tsc --noEmit src/plugin/anthropic/logger.ts 2>&1 | head -20`

If tsc doesn't work standalone, just verify no syntax errors: `bun build --no-bundle src/plugin/anthropic/logger.ts --outdir /tmp/test-build 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/logger.ts
git commit -m "feat(anthropic): add debug logger with secret redaction"
```

---

## Task 2: Model Config Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/model-config.ts`

- [ ] **Step 1: Create model-config.ts**

```typescript
import { execSync } from "node:child_process"

const DEFAULT_CLI_VERSION = "2.1.87"

let _cliVersion: string | null = null

export function cliVersion(): string {
  if (!_cliVersion) {
    try {
      const out = execSync("claude --version 2>/dev/null", { timeout: 5000 }).toString().trim()
      const match = out.match(/^([\d.]+)/)
      _cliVersion = match?.[1] ?? DEFAULT_CLI_VERSION
    } catch {
      _cliVersion = DEFAULT_CLI_VERSION
    }
  }
  return _cliVersion
}

export function userAgent(): string {
  return `claude-cli/${cliVersion()} (external, cli)`
}

export function billingHeader(model?: string): string {
  return JSON.stringify({
    cli_version: cliVersion(),
    ...(model ? { model } : {}),
  })
}

/** Extra beta flags for specific model families */
export function getModelBetas(modelId: string): string[] {
  if (modelId.includes("4-6")) {
    return ["effort-2025-11-24"]
  }
  return []
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/model-config.ts
git commit -m "feat(anthropic): add model config with CLI version detection"
```

---

## Task 3: Betas Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/betas.ts`

- [ ] **Step 1: Create betas.ts**

```typescript
import { getModelBetas } from "./model-config"

export const BASE_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "adaptive-thinking-2026-01-28",
]

// Only context-1m is excluded progressively; interleaved-thinking is a base beta
// and must never be removed.
const LONG_CONTEXT_BETAS = [
  "context-1m-2025-08-07",
]

const LONG_CONTEXT_INDICATORS = ["context", "1m", "token limit", "too many tokens"]

export function isLongContextEnabled(): boolean {
  return process.env.ANTHROPIC_ENABLE_1M_CONTEXT === "true"
}

/** Merge base + model + long-context + existing header betas, deduplicated */
export function mergeBetas(existingHeader: string, modelId?: string): string {
  const betas = [...BASE_BETAS]
  if (modelId) betas.push(...getModelBetas(modelId))
  if (isLongContextEnabled()) betas.push(...LONG_CONTEXT_BETAS)

  return Array.from(
    new Set([
      ...betas,
      ...existingHeader
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ]),
  ).join(",")
}

/** Check if an error body indicates a long-context issue */
export function isLongContextError(body: string): boolean {
  const lower = body.toLowerCase()
  return LONG_CONTEXT_INDICATORS.some((indicator) => lower.includes(indicator))
}

/**
 * Progressive exclusion: returns new beta header with one long-context beta removed.
 * Returns null if no more long-context betas to remove.
 */
export function excludeNextLongContextBeta(currentHeader: string): string | null {
  const parts = currentHeader.split(",").map((b) => b.trim())
  for (const lcBeta of LONG_CONTEXT_BETAS) {
    const idx = parts.indexOf(lcBeta)
    if (idx !== -1) {
      parts.splice(idx, 1)
      return parts.filter(Boolean).join(",")
    }
  }
  return null
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/betas.ts
git commit -m "feat(anthropic): add beta flag management with progressive exclusion"
```

---

## Task 4: Credentials Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/credentials.ts`

- [ ] **Step 1: Create credentials.ts**

```typescript
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { logger } from "./logger"

export interface OAuthCredentials {
  access: string
  refresh: string
  expires: number
}

const CACHE_TTL = 30_000
const EXPIRY_BUFFER = 60_000 // 60 seconds

let _cache: OAuthCredentials | null = null
let _cacheTime = 0

export function credentialsPath(): string {
  return process.env.CLAUDE_CREDENTIALS_PATH ?? path.join(os.homedir(), ".claude", ".credentials.json")
}

/** Read Claude CLI credentials with 30s TTL cache */
export function loadCredentials(): OAuthCredentials | null {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    logger.debug("cred.read", "returning cached credentials")
    return _cache
  }

  const credPath = credentialsPath()
  try {
    if (!fs.existsSync(credPath)) return null
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"))

    // Skip MCP-only entries
    if (raw?.mcpOAuth && !raw?.claudeAiOauth) return null

    const oauth = raw?.claudeAiOauth
    if (!oauth || typeof oauth.refreshToken !== "string") return null

    const expiresAt =
      typeof oauth.expiresAt === "number"
        ? oauth.expiresAt > 1e12
          ? oauth.expiresAt
          : oauth.expiresAt * 1000
        : Date.now()

    _cache = {
      access: typeof oauth.accessToken === "string" ? oauth.accessToken : "",
      refresh: oauth.refreshToken,
      expires: expiresAt,
    }
    _cacheTime = Date.now()
    logger.debug("cred.read", "loaded credentials from file", { path: credPath, expires: new Date(expiresAt).toISOString() })
    return _cache
  } catch {
    return null
  }
}

/** Check if credentials are still valid (not within 60s of expiry) */
export function isValid(creds: OAuthCredentials): boolean {
  return creds.access !== "" && creds.expires > Date.now() + EXPIRY_BUFFER
}

/** Invalidate the in-memory cache (e.g., after CLI forced refresh) */
export function invalidateCache(): void {
  _cache = null
  _cacheTime = 0
}

/** Write refreshed tokens back to Claude CLI credentials file */
export function writeBack(creds: OAuthCredentials): void {
  const credPath = credentialsPath()
  try {
    const raw = fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, "utf8")) : {}
    if (!raw.claudeAiOauth) raw.claudeAiOauth = {}
    raw.claudeAiOauth.accessToken = creds.access
    raw.claudeAiOauth.refreshToken = creds.refresh
    raw.claudeAiOauth.expiresAt = creds.expires
    fs.writeFileSync(credPath, JSON.stringify(raw, null, 2), { mode: 0o600 })
    logger.debug("cred.write", "wrote tokens back to credentials file")

    // Update cache
    _cache = creds
    _cacheTime = Date.now()
  } catch (err) {
    logger.warn("failed to write back credentials", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Start background auth.json sync via sdk.auth.set().
 * Returns a cleanup function to stop the interval.
 */
export function startAuthSync(
  sdk: { auth: { set: (input: { path: { id: string }; body: any }) => Promise<unknown> } },
  id: string,
  getAuth: () => Promise<{ type: string; accountId?: string; enterpriseUrl?: string }>,
): () => void {
  const SYNC_INTERVAL = 300_000 // 5 minutes

  const sync = async () => {
    const creds = loadCredentials()
    if (!creds || !creds.access) return
    const auth = await getAuth()
    try {
      await sdk.auth.set({
        path: { id },
        body: {
          type: "oauth" as const,
          access: creds.access,
          refresh: creds.refresh,
          expires: creds.expires,
          ...(auth.accountId ? { accountId: auth.accountId } : {}),
          ...(auth.enterpriseUrl ? { enterpriseUrl: auth.enterpriseUrl } : {}),
        },
      })
      logger.debug("sync.auth_json", "synced credentials to auth.json")
    } catch (err) {
      logger.warn("auth.json sync failed", { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Sync on startup
  sync()

  const timer = setInterval(sync, SYNC_INTERVAL)
  timer.unref() // Don't prevent process exit
  return () => clearInterval(timer)
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/credentials.ts
git commit -m "feat(anthropic): add credential management with cache, write-back, sync"
```

---

## Task 5: Refresh Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/refresh.ts`

- [ ] **Step 1: Create refresh.ts**

```typescript
import { spawn, execSync } from "node:child_process"
import { loadCredentials, invalidateCache, writeBack, type OAuthCredentials } from "./credentials"
import { logger } from "./logger"

const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const RETRY_BASE_MS = 1200
const MAX_ATTEMPTS = 4
const MAX_DELAY_MS = 30_000
const MAX_CLI_RETRIES = 2

// Embedded subprocess script — reads refresh token from stdin, POSTs to OAuth endpoint
const REFRESH_SCRIPT = `
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  const refreshToken = Buffer.concat(chunks).toString().trim();
  try {
    const res = await fetch('${OAUTH_TOKEN_URL}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: '${OAUTH_CLIENT_ID}',
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryMs = res.headers.get('retry-after-ms');
      const retrySec = res.headers.get('retry-after');
      process.stderr.write(JSON.stringify({
        error: text,
        status: res.status,
        ...(retryMs ? { retry_after_ms: Number(retryMs) } : {}),
        ...(retrySec ? { retry_after_sec: Number(retrySec) } : {}),
      }));
      process.exit(1);
    }
    const json = await res.json();
    process.stdout.write(JSON.stringify(json));
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: String(err), status: 0 }));
    process.exit(1);
  }
});
`.trim()

interface SubprocessResult {
  success: boolean
  data?: { access_token: string; refresh_token: string; expires_in: number }
  error?: { error: string; status: number; retry_after_ms?: number; retry_after_sec?: number }
}

function runRefreshSubprocess(refreshToken: string): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const runtime = typeof Bun !== "undefined" ? "bun" : "node"
    const child = spawn(runtime, ["-e", REFRESH_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

    child.on("close", (code: number | null) => {
      if (code === 0 && stdout) {
        try {
          resolve({ success: true, data: JSON.parse(stdout) })
          return
        } catch {}
      }
      try {
        resolve({ success: false, error: JSON.parse(stderr) })
      } catch {
        resolve({ success: false, error: { error: stderr || "subprocess failed", status: 0 } })
      }
    })

    child.on("error", (err: Error) => {
      resolve({ success: false, error: { error: err.message, status: 0 } })
    })

    child.stdin.write(refreshToken)
    child.stdin.end()
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isExpired(errorText: string): boolean {
  const lower = errorText.toLowerCase()
  return lower.includes("invalid_grant") || lower.includes("expired") || lower.includes("revoked")
}

/**
 * Tier 1: Subprocess-based OAuth token refresh.
 * Returns refreshed credentials, "expired" if token is revoked, or null on transient failure.
 */
async function refreshViaSubprocess(refreshToken: string): Promise<OAuthCredentials | "expired" | null> {
  logger.debug("refresh.start", "attempting subprocess OAuth refresh")

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await runRefreshSubprocess(refreshToken)

    if (result.success && result.data) {
      const creds: OAuthCredentials = {
        access: result.data.access_token,
        refresh: result.data.refresh_token,
        expires: Date.now() + result.data.expires_in * 1000 - 5 * 60 * 1000,
      }
      writeBack(creds)
      logger.debug("refresh.success", "subprocess refresh succeeded", { attempt })
      return creds
    }

    if (result.error) {
      if (isExpired(result.error.error)) {
        logger.error("refresh token expired or revoked")
        return "expired" // Signal to caller — don't retry
      }

      if (result.error.status === 429) {
        const delay = result.error.retry_after_ms
          ? Math.min(result.error.retry_after_ms, MAX_DELAY_MS)
          : result.error.retry_after_sec
            ? Math.min(result.error.retry_after_sec * 1000, MAX_DELAY_MS)
            : Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_DELAY_MS)
        logger.warn("OAuth token endpoint rate-limited", { attempt, delay })
        await sleep(delay)
        continue
      }

      logger.warn("subprocess refresh attempt failed", {
        attempt,
        status: result.error.status,
        error: result.error.error.slice(0, 200),
      })
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = RETRY_BASE_MS * 2 ** attempt
      await sleep(delay)
    }
  }

  return null
}

/**
 * Tier 2: Force Claude CLI to refresh its token by running a lightweight command.
 */
function refreshViaCli(): OAuthCredentials | null {
  for (let i = 0; i < MAX_CLI_RETRIES; i++) {
    try {
      logger.debug("refresh.start", "forcing Claude CLI refresh", { attempt: i })
      execSync("claude -p . --model haiku", { timeout: 30_000, stdio: "pipe" })
      invalidateCache()
      const creds = loadCredentials()
      if (creds && creds.access && creds.expires > Date.now() + 60_000) {
        logger.debug("refresh.success", "CLI refresh succeeded", { attempt: i })
        return creds
      }
    } catch {
      logger.warn("Claude CLI refresh attempt failed", { attempt: i })
    }
  }
  return null
}

/**
 * Full refresh flow: Tier 1 (subprocess) -> Tier 2 (CLI fallback).
 * Tracks whether the failure was due to an expired/revoked token vs. transient error.
 */
export async function refreshToken(refreshTokenValue: string): Promise<OAuthCredentials> {
  // Tier 1: subprocess
  const subResult = await refreshViaSubprocess(refreshTokenValue)
  if (subResult === "expired") {
    throw new Error(
      "Anthropic OAuth token expired or revoked. Re-authenticate: use 'Claude Code (import from CLI)' or run `opencode providers login --provider anthropic`.",
    )
  }
  if (subResult) return subResult

  // Tier 2: CLI fallback
  const cliResult = refreshViaCli()
  if (cliResult) return cliResult

  throw new Error(
    "OAuth token refresh failed after all attempts. Try again in a few minutes, or re-import credentials from Claude CLI.",
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/refresh.ts
git commit -m "feat(anthropic): add subprocess OAuth refresh with CLI fallback"
```

---

## Task 6: Transforms Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/transforms.ts`

- [ ] **Step 1: Create transforms.ts**

```typescript
const TOOL_PREFIX = "mcp_"
const SYSTEM_REPLACE_FROM = "You are OpenCode, the best coding agent on the planet."
const SYSTEM_REPLACE_TO = "You are Claude Code, Anthropic's official CLI for Claude."

/** Add mcp_ prefix to tool names in request body + rewrite system prompt */
export function rewriteRequest(body: string): string {
  try {
    const parsed = JSON.parse(body)

    // System prompt rewrite
    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item: { type?: string; text?: string }) => {
        if (item.type !== "text" || !item.text) return item
        return { ...item, text: item.text.replace(SYSTEM_REPLACE_FROM, SYSTEM_REPLACE_TO) }
      })
    }

    // Add mcp_ prefix to tools array
    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: { name?: string }) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }))
    }

    // Add mcp_ prefix to tool_use blocks in messages
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg: { content?: Array<{ type?: string; name?: string }> }) => {
        if (!msg.content || !Array.isArray(msg.content)) return msg
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (block.type !== "tool_use" || !block.name) return block
            return { ...block, name: `${TOOL_PREFIX}${block.name}` }
          }),
        }
      })
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

const MCP_PREFIX_REGEX = /"name"\s*:\s*"mcp_([^"]+)"/g

/** Strip mcp_ prefix from tool names in a text chunk */
function stripMcpPrefix(text: string): string {
  return text.replace(MCP_PREFIX_REGEX, '"name": "$1"')
}

/**
 * Wrap a streaming response with SSE-aware buffering.
 * Buffers at event boundaries (\n\n) to avoid corrupting tool names
 * that span chunk boundaries.
 */
export function wrapResponse(res: Response): Response {
  if (!res.body) return res

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buffer = ""

  const stream = new ReadableStream({
    async pull(ctrl) {
      const chunk = await reader.read()

      if (chunk.done) {
        // Flush remaining buffer
        if (buffer) {
          ctrl.enqueue(enc.encode(stripMcpPrefix(buffer)))
          buffer = ""
        }
        ctrl.close()
        return
      }

      buffer += dec.decode(chunk.value, { stream: true })

      // Process complete SSE events (delimited by \n\n)
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary + 2) // include the \n\n
        ctrl.enqueue(enc.encode(stripMcpPrefix(event)))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")
      }
    },
  })

  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export { SYSTEM_REPLACE_FROM, SYSTEM_REPLACE_TO }
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/transforms.ts
git commit -m "feat(anthropic): add request/response transforms with SSE buffering"
```

---

## Task 7: Fetch Interceptor Module

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/fetch.ts`

- [ ] **Step 1: Create fetch.ts**

```typescript
import type { PluginInput } from "@opencode-ai/plugin"
import { loadCredentials, isValid, type OAuthCredentials } from "./credentials"
import { refreshToken } from "./refresh"
import { rewriteRequest, wrapResponse } from "./transforms"
import { mergeBetas, isLongContextError, excludeNextLongContextBeta } from "./betas"
import { userAgent, billingHeader } from "./model-config"
import { logger } from "./logger"

const RETRY_BASE_MS = 1200
const MAX_RETRY_DELAY_MS = 30_000

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Single-flight map to serialize concurrent refresh attempts
const inflight = new Map<string, Promise<void>>()

/**
 * Ensure a valid access token is available.
 * Uses single-flight pattern to avoid redundant concurrent refreshes.
 */
async function ensure(
  id: string,
  getAuth: () => Promise<{
    type: string
    access?: string
    refresh?: string
    expires?: number
    accountId?: string
    enterpriseUrl?: string
  }>,
  sdk: PluginInput["client"],
  force?: boolean,
): Promise<{ access: string }> {
  const auth = await getAuth()
  if (auth.type !== "oauth") return { access: "" }
  if (!force && auth.access && (auth.expires ?? 0) > Date.now()) return { access: auth.access }

  // Try cached CLI credentials before network
  if (!force) {
    const cliCreds = loadCredentials()
    if (cliCreds && isValid(cliCreds)) {
      logger.debug("fetch.request", "using fresh CLI credentials")
      try {
        await sdk.auth.set({
          path: { id },
          body: {
            type: "oauth" as const,
            access: cliCreds.access,
            refresh: cliCreds.refresh,
            expires: cliCreds.expires,
            ...(auth.accountId ? { accountId: auth.accountId } : {}),
            ...(auth.enterpriseUrl ? { enterpriseUrl: auth.enterpriseUrl } : {}),
          },
        })
      } catch (e) {
        logger.warn("failed to persist CLI credentials", { error: e instanceof Error ? e.message : String(e) })
      }
      return { access: cliCreds.access }
    }
  }

  // Single-flight: wait for in-progress refresh
  const run = inflight.get(id)
  if (run) {
    await run.catch(() => {})
    const fresh = await getAuth()
    if (fresh.type === "oauth" && fresh.access && (fresh.expires ?? 0) > Date.now()) {
      return { access: fresh.access }
    }
  }

  const next = (async () => {
    try {
      const refreshTokenValue = auth.refresh
      if (!refreshTokenValue) throw new Error("No refresh token available")

      const creds = await refreshToken(refreshTokenValue)
      await sdk.auth.set({
        path: { id },
        body: {
          type: "oauth" as const,
          access: creds.access,
          refresh: creds.refresh,
          expires: creds.expires,
          ...(auth.accountId ? { accountId: auth.accountId } : {}),
          ...(auth.enterpriseUrl ? { enterpriseUrl: auth.enterpriseUrl } : {}),
        },
      })
      logger.debug("refresh.success", "token refreshed and persisted")
    } catch (err) {
      // Check storage one more time
      const retry = await getAuth()
      if (retry.type === "oauth" && retry.access && (retry.expires ?? 0) > Date.now()) {
        logger.info("refresh failed but storage has fresh token")
        return
      }
      throw err
    } finally {
      inflight.delete(id)
    }
  })()

  inflight.set(id, next)
  await next

  const result = await getAuth()
  if (result.type !== "oauth") return { access: "" }
  return { access: result.access ?? "" }
}

function buildHeaders(
  req: Request | string | URL,
  init: RequestInit | undefined,
  accessToken: string,
  modelId?: string,
): Headers {
  const hdrs = new Headers()

  if (req instanceof Request) {
    req.headers.forEach((v, k) => hdrs.set(k, v))
  }

  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => hdrs.set(k, v))
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers as [string, string][]) {
        if (v !== undefined) hdrs.set(k, String(v))
      }
    } else {
      for (const [k, v] of Object.entries(init.headers)) {
        if (v !== undefined) hdrs.set(k, String(v))
      }
    }
  }

  hdrs.set("authorization", `Bearer ${accessToken}`)
  hdrs.set("anthropic-beta", mergeBetas(hdrs.get("anthropic-beta") || "", modelId))
  hdrs.set("user-agent", userAgent())
  hdrs.set("x-app", "cli")
  hdrs.set("x-anthropic-billing-header", billingHeader(modelId))
  hdrs.delete("x-api-key")

  return hdrs
}

function addBetaParam(req: Request | string | URL): Request | string | URL {
  try {
    const parsed = typeof req === "string" || req instanceof URL ? new URL(req.toString()) : new URL(req.url)
    if (parsed.pathname === "/v1/messages" && !parsed.searchParams.has("beta")) {
      parsed.searchParams.set("beta", "true")
      return req instanceof Request ? new Request(parsed.toString(), req) : parsed
    }
  } catch {}
  return req
}

/**
 * Create a custom fetch function that handles OAuth auth, tool name transforms,
 * beta flags, retries, and SSE stream buffering.
 */
export function createFetch(
  id: string,
  getAuth: () => Promise<{ type: string; access?: string; refresh?: string; expires?: number; accountId?: string; enterpriseUrl?: string }>,
  sdk: PluginInput["client"],
) {
  return async function customFetch(req: Request | string | URL, init?: RequestInit): Promise<Response> {
    const token = await ensure(id, getAuth, sdk)
    if (!token.access) return fetch(req, init)

    const opts = init ?? {}
    const hdrs = buildHeaders(req, init, token.access)
    let body = opts.body
    if (body && typeof body === "string") {
      body = rewriteRequest(body)
    }

    const target = addBetaParam(req)

    logger.debug("fetch.request", "sending API request", {
      url: typeof target === "string" ? target : target instanceof URL ? target.toString() : target.url,
    })

    let response = await fetch(target, { ...opts, body, headers: hdrs })

    // 429/529 retry with exponential backoff
    if (response.status === 429 || response.status === 529) {
      const afterMs = response.headers.get("retry-after-ms")
      const afterSec = response.headers.get("retry-after")
      const delay = afterMs
        ? Math.min(Number(afterMs), MAX_RETRY_DELAY_MS)
        : afterSec
          ? Math.min(Number(afterSec) * 1000, MAX_RETRY_DELAY_MS)
          : RETRY_BASE_MS
      logger.warn("rate limited, retrying", { status: response.status, delay })
      await sleep(delay)
      response = await fetch(target, { ...opts, body, headers: hdrs })
    }

    // Long-context beta progressive exclusion
    if ((response.status === 400 || response.status === 429) && isLongContextError(await response.clone().text())) {
      let betaHeader = hdrs.get("anthropic-beta") || ""
      for (let i = 0; i < 2; i++) {
        const reduced = excludeNextLongContextBeta(betaHeader)
        if (!reduced) break
        betaHeader = reduced
        hdrs.set("anthropic-beta", betaHeader)
        logger.warn("excluding long-context beta, retrying", { attempt: i })
        response = await fetch(target, { ...opts, body, headers: hdrs })
        if (response.status !== 400 && response.status !== 429) break
        if (!isLongContextError(await response.clone().text())) break
      }
    }

    // 401 retry with force refresh
    if (response.status === 401) {
      logger.warn("401 received, attempting force refresh")
      const prev = token.access
      try {
        const next = await ensure(id, getAuth, sdk, true)
        if (next.access && next.access !== prev) {
          hdrs.set("authorization", `Bearer ${next.access}`)
          const retry = await fetch(target, { ...opts, body, headers: hdrs })
          logger.debug("fetch.response", "401 retry completed", { status: retry.status })
          return wrapResponse(retry)
        }
      } catch (err) {
        logger.error("401 refresh failed", { error: err instanceof Error ? err.message : String(err) })
      }
    }

    return wrapResponse(response)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/fetch.ts
git commit -m "feat(anthropic): add custom fetch interceptor with retry and SSE buffering"
```

---

## Task 8: Plugin Entry (index.ts) + Wiring

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/index.ts`
- Modify: `packages/opencode/src/plugin/index.ts:11`
- Delete: `packages/opencode/src/plugin/anthropic.ts`

- [ ] **Step 1: Create index.ts**

```typescript
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { loadCredentials, invalidateCache, startAuthSync } from "./credentials"
import { createFetch } from "./fetch"
import { SYSTEM_REPLACE_TO } from "./transforms"
import { logger } from "./logger"
import { execSync } from "node:child_process"

/** Force Claude CLI to refresh, then re-read credentials */
function refreshViaClaudeCli(): ReturnType<typeof loadCredentials> {
  try {
    logger.info("triggering Claude CLI to refresh token")
    execSync("claude --print --model claude-haiku-4 ping", { timeout: 30_000, stdio: "pipe" })
    invalidateCache()
    return loadCredentials()
  } catch {
    logger.warn("Claude CLI refresh trigger failed")
    return null
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    "experimental.chat.system.transform": async (
      ctx: { model?: { providerID?: string } },
      out: { system: string[] },
    ) => {
      if (!ctx.model?.providerID?.startsWith("anthropic")) return
      const prefix = SYSTEM_REPLACE_TO
      if (out.system.length > 0 && !out.system[0].startsWith(prefix)) {
        out.system[0] = prefix + "\n\n" + out.system[0]
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const id = (getAuth as typeof getAuth & { providerID?: string }).providerID ?? "anthropic"
        let auth = await getAuth()

        // Auto-import Claude CLI credentials if no valid OAuth token exists
        if (auth.type !== "oauth" || !auth.access || (auth.expires ?? 0) < Date.now()) {
          const cliCreds = loadCredentials()
          if (cliCreds && cliCreds.refresh && cliCreds.expires > Date.now()) {
            logger.info("auto-importing Claude CLI credentials", {
              expires: new Date(cliCreds.expires).toISOString(),
            })
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

        // Set costs to 0 (billing through Claude Code subscription)
        for (const model of Object.values(provider.models)) {
          ;(model as { cost?: unknown }).cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        // Start background auth.json sync
        startAuthSync(sdk, id, getAuth as () => Promise<{ type: string; accountId?: string; enterpriseUrl?: string }>)

        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: createFetch(
            id,
            getAuth as () => Promise<{ type: string; access?: string; refresh?: string; expires?: number; accountId?: string; enterpriseUrl?: string }>,
            sdk,
          ),
        }
      },
      methods: [
        {
          label: "Claude Code (auto)",
          type: "oauth" as const,
          authorize: async () => {
            return {
              url: "",
              instructions: "Importing credentials from Claude CLI...",
              method: "auto" as const,
              callback: async () => {
                let creds = loadCredentials()
                if (!creds || !creds.refresh || creds.expires < Date.now()) {
                  creds = refreshViaClaudeCli()
                }
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
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
```

- [ ] **Step 2: Update import in plugin/index.ts**

In `packages/opencode/src/plugin/index.ts`, line 11, change:
```typescript
// OLD:
import { AnthropicAuthPlugin } from "./anthropic"
// NEW:
import { AnthropicAuthPlugin } from "./anthropic/index"
```

- [ ] **Step 3: Delete old monolithic file**

```bash
rm packages/opencode/src/plugin/anthropic.ts
```

- [ ] **Step 4: Verify build**

```bash
cd packages/opencode && bun build --no-bundle src/plugin/anthropic/index.ts --outdir /tmp/test-build 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/anthropic/
git add packages/opencode/src/plugin/index.ts
git rm packages/opencode/src/plugin/anthropic.ts
git commit -m "feat(anthropic): modular rewrite — Griffin-parity auth plugin"
```

---

## Task 9: Update Tests

**Files:**
- Modify: `packages/opencode/test/plugin/anthropic.test.ts`

The existing tests test dual-endpoint fallback and in-process network refresh — both removed. New tests should cover:
1. Credential loading + cache
2. Subprocess refresh (mocked)
3. SSE stream buffering
4. Beta progressive exclusion
5. End-to-end fetch with mocked credentials

- [ ] **Step 1: Rewrite test file**

```typescript
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test"
import { AnthropicAuthPlugin } from "../../src/plugin/anthropic/index"

const fetch0 = globalThis.fetch
const originalCredPath = process.env.CLAUDE_CREDENTIALS_PATH

beforeEach(() => {
  // Isolate tests from real credentials file
  process.env.CLAUDE_CREDENTIALS_PATH = "/tmp/.nonexistent-credentials.json"
})

afterEach(() => {
  globalThis.fetch = fetch0
  if (originalCredPath !== undefined) {
    process.env.CLAUDE_CREDENTIALS_PATH = originalCredPath
  } else {
    delete process.env.CLAUDE_CREDENTIALS_PATH
  }
})

function makeSdk() {
  const state: Record<string, unknown> = {}
  return {
    client: {
      auth: {
        set: async (input: { path: { id: string }; body: Record<string, unknown> }) => {
          Object.assign(state, { id: input.path.id, ...input.body })
        },
      },
    },
    state,
  }
}

function makeInput(sdk: ReturnType<typeof makeSdk>) {
  return {
    client: sdk.client,
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("https://example.com"),
    $: {},
  } as unknown as Parameters<typeof AnthropicAuthPlugin>[0]
}

describe("AnthropicAuthPlugin", () => {
  test("loader returns empty for non-oauth auth", async () => {
    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const auth = plugin.auth!
    const cfg = await auth.loader!(
      async () => ({ type: "api", key: "sk-test" }),
      { models: {} } as any,
    )
    expect(cfg).toEqual({})
  })

  test("fetch interceptor sets correct headers", async () => {
    const captured: { headers?: Headers }[] = []
    globalThis.fetch = (async (_req: any, init?: RequestInit) => {
      captured.push({ headers: new Headers(init?.headers as any) })
      return Response.json({ type: "message", content: [] })
    }) as typeof fetch

    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const auth = plugin.auth!

    const getAuth = Object.assign(
      async () => ({
        type: "oauth" as const,
        access: "test-token",
        refresh: "refresh-1",
        expires: Date.now() + 3600_000,
      }),
      { providerID: "anthropic" },
    )

    const cfg = await auth.loader!(getAuth, { models: { claude: {} } } as any)
    await cfg.fetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })

    const hdrs = captured[0]?.headers
    expect(hdrs?.get("authorization")).toBe("Bearer test-token")
    expect(hdrs?.get("x-app")).toBe("cli")
    expect(hdrs?.has("x-api-key")).toBe(false)
    expect(hdrs?.get("anthropic-beta")).toContain("claude-code-20250219")
    expect(hdrs?.get("user-agent")).toMatch(/^claude-cli\//)
  })

  test("fetch interceptor adds mcp_ prefix to tool names", async () => {
    let capturedBody = ""
    globalThis.fetch = (async (_req: any, init?: RequestInit) => {
      capturedBody = init?.body as string
      return Response.json({ type: "message", content: [] })
    }) as typeof fetch

    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const auth = plugin.auth!

    const getAuth = Object.assign(
      async () => ({
        type: "oauth" as const,
        access: "test-token",
        refresh: "r",
        expires: Date.now() + 3600_000,
      }),
      { providerID: "anthropic" },
    )

    const cfg = await auth.loader!(getAuth, { models: { claude: {} } } as any)
    await cfg.fetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        tools: [{ name: "read_file", description: "reads" }],
        messages: [{ role: "assistant", content: [{ type: "tool_use", name: "read_file", id: "1", input: {} }] }],
      }),
    })

    const parsed = JSON.parse(capturedBody)
    expect(parsed.tools[0].name).toBe("mcp_read_file")
    expect(parsed.messages[0].content[0].name).toBe("mcp_read_file")
  })

  test("response strips mcp_ prefix from streaming SSE", async () => {
    const sseData = [
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read_file"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
    ]

    globalThis.fetch = (async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(ctrl) {
          for (const chunk of sseData) {
            ctrl.enqueue(encoder.encode(chunk))
          }
          ctrl.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const auth = plugin.auth!

    const getAuth = Object.assign(
      async () => ({
        type: "oauth" as const,
        access: "test-token",
        refresh: "r",
        expires: Date.now() + 3600_000,
      }),
      { providerID: "anthropic" },
    )

    const cfg = await auth.loader!(getAuth, { models: { claude: {} } } as any)
    const response = await cfg.fetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
    })

    const text = await response.text()
    expect(text).toContain('"name": "read_file"')
    expect(text).not.toContain('"name":"mcp_read_file"')
  })

  test("SSE buffering handles chunks split across event boundaries", async () => {
    // Split an event across two chunks (mid-event split)
    const part1 = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_'
    const part2 = 'write_file"}}\n\nevent: done\ndata: {"type":"done"}\n\n'

    globalThis.fetch = (async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(part1))
          ctrl.enqueue(encoder.encode(part2))
          ctrl.close()
        },
      })
      return new Response(stream, { status: 200 })
    }) as typeof fetch

    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const auth = plugin.auth!

    const getAuth = Object.assign(
      async () => ({
        type: "oauth" as const,
        access: "test-token",
        refresh: "r",
        expires: Date.now() + 3600_000,
      }),
      { providerID: "anthropic" },
    )

    const cfg = await auth.loader!(getAuth, { models: { claude: {} } } as any)
    const response = await cfg.fetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
    })

    const text = await response.text()
    // Should correctly strip mcp_ even though name was split across chunks
    expect(text).toContain('"name": "write_file"')
    expect(text).not.toContain("mcp_write_file")
  })

  test("401 triggers force refresh and retry", async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      if (callCount === 1) {
        return new Response("unauthorized", { status: 401 })
      }
      return Response.json({ type: "message", content: [] })
    }) as typeof fetch

    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const auth = plugin.auth!

    let tokenVersion = 0
    const getAuth = Object.assign(
      async () => ({
        type: "oauth" as const,
        access: `token-${++tokenVersion}`,
        refresh: "r",
        expires: Date.now() + 3600_000,
      }),
      { providerID: "anthropic" },
    )

    const cfg = await auth.loader!(getAuth, { models: { claude: {} } } as any)
    const response = await cfg.fetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(callCount).toBe(2)
  })

  test("methods array has two entries", async () => {
    const sdk = makeSdk()
    const plugin = await AnthropicAuthPlugin(makeInput(sdk))
    const methods = plugin.auth!.methods
    expect(methods).toHaveLength(2)
    expect(methods[0].label).toBe("Claude Code (auto)")
    expect(methods[0].type).toBe("oauth")
    expect(methods[1].label).toBe("Manually enter API Key")
    expect(methods[1].type).toBe("api")
  })
})
```

- [ ] **Step 2: Run tests**

```bash
cd packages/opencode && bun test test/plugin/anthropic.test.ts --timeout 30000
```

Expected: All tests pass.

- [ ] **Step 3: Fix any failures and re-run**

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/test/plugin/anthropic.test.ts
git commit -m "test(anthropic): rewrite tests for modular architecture"
```

---

## Task 10: Check `@openauthjs/openauth/pkce` Dependency

**Files:**
- Possibly modify: `packages/opencode/package.json`

- [ ] **Step 1: Verify pkce is not used elsewhere**

```bash
cd /home/yevhenii/Projects/opencode-fork && grep -r "@openauthjs/openauth/pkce" packages/opencode/src/ --include="*.ts" | grep -v anthropic
```

Expected: No results (only the deleted `anthropic.ts` used it).

- [ ] **Step 2: If unused, remove the dependency**

Only if no other files import from `@openauthjs/openauth`:

```bash
cd packages/opencode && grep -r "@openauthjs/openauth" src/ --include="*.ts" | head
```

If empty, remove from package.json. If other imports exist, keep it.

- [ ] **Step 3: Commit if changed**

```bash
git add packages/opencode/package.json
git commit -m "chore: remove unused @openauthjs/openauth dependency"
```

---

## Task 11: Full Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
cd packages/opencode && bun test --timeout 30000
```

- [ ] **Step 2: Verify build works**

```bash
cd packages/opencode && bun run build 2>&1 | tail -20
```

If build script doesn't exist or fails for unrelated reasons, at minimum verify type-checking:

```bash
cd packages/opencode && bunx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Fix any issues found**

- [ ] **Step 4: Final commit if needed**

---

## Task 12: Version Notification Fix (Separate Concern)

**Context:** The version update notification may not fire because:
1. `OPENCODE_VERSION` is a build-time constant set by `script/build.ts`. In dev mode it's `"local"`.
2. `VERSION_RAW === latest` (upgrade.ts:60) — when VERSION is `"local"`, this is never true, so the event always fires.
3. But `"local"` doesn't contain `"fork"` (app.tsx:819), so fork detection doesn't trigger either.
4. The dialog/toast then shows, but `semver.gt(version, skipped)` may crash on `"local"` (not valid semver).

**Files:**
- Modify: `packages/opencode/src/cli/upgrade.ts:60`
- Modify: `packages/opencode/src/cli/cmd/tui/app.tsx:819-830`

- [ ] **Step 1: Read current upgrade.ts and app.tsx fork handling**

Verify the issue by reading the relevant code sections.

- [ ] **Step 2: Fix upgrade.ts to handle local/dev builds**

In `packages/opencode/src/cli/upgrade.ts`, around line 60:

```typescript
// OLD:
if (Installation.VERSION_RAW === latest) return

// NEW:
// Skip version check for local dev builds (no OPENCODE_VERSION set at build time)
if (Installation.VERSION_RAW === latest || Installation.isLocal()) return
```

- [ ] **Step 3: Fix app.tsx fork detection for dev builds**

In `packages/opencode/src/cli/cmd/tui/app.tsx`, around line 819:

```typescript
// OLD:
const isFork = Installation.VERSION.includes("fork")

// NEW:
const isFork = Installation.VERSION.includes("fork") || Installation.isLocal()
```

And update the message for local builds (around line 821-828):

```typescript
if (isFork) {
  if (Installation.isLocal()) {
    // Dev build — just show latest upstream for reference
    toast.show({
      variant: "info",
      title: "Upstream Update",
      message: `Upstream OpenCode v${version} available (local dev build). Rebuild to update.`,
      duration: 10000,
    })
    return
  }
  const base = Installation.VERSION.replace(/-fork.*$/, "")
  if (version === base || !semver.gt(version, base)) return
  // ... existing fork toast
}
```

- [ ] **Step 4: Run tests**

```bash
cd packages/opencode && bun test --timeout 30000
```

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/cli/upgrade.ts packages/opencode/src/cli/cmd/tui/app.tsx
git commit -m "fix: handle version notifications for local/dev builds"
```

---

## Task 13: Upstream Sync & Merge

- [ ] **Step 1: Fetch latest upstream**

```bash
git fetch upstream
```

- [ ] **Step 2: Check divergence**

```bash
git log --oneline upstream/dev..HEAD
git log --oneline HEAD..upstream/dev
```

- [ ] **Step 3: Rebase or merge upstream/dev**

Prefer rebase to keep history clean:

```bash
git rebase upstream/dev
```

If conflicts occur in `anthropic.ts` (which was deleted): accept deletion, since new code is in `anthropic/` directory.

If conflicts are complex, fall back to merge:

```bash
git merge upstream/dev
```

- [ ] **Step 4: Run tests after sync**

```bash
cd packages/opencode && bun test --timeout 30000
```

- [ ] **Step 5: Fix any merge/rebase conflicts and commit**

- [ ] **Step 6: Verify everything still works**

```bash
cd packages/opencode && bun test test/plugin/anthropic.test.ts --timeout 30000
```
