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
