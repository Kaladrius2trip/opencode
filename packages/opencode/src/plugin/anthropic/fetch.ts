import type { PluginInput } from "@opencode-ai/plugin"
import { loadCredentials, isValid } from "./credentials"
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
