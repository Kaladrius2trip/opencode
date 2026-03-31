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
