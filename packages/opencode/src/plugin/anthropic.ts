import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { generatePKCE } from "@openauthjs/openauth/pkce"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { OAUTH_DUMMY_KEY } from "../auth"

const log = Log.create({ service: "plugin.anthropic" })
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const TOOL_PREFIX = "mcp_"
const SYSTEM_REPLACE_FROM = "You are OpenCode, the best coding agent on the planet."
const SYSTEM_REPLACE_TO = "You are Claude Code, Anthropic's official CLI for Claude."

let inflight: Promise<void> | null = null

function tokenUrl(mode: "max" | "console") {
  return `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/token`
}

function form(data: Record<string, string>) {
  return new URLSearchParams(data).toString()
}

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE()
  const host = mode === "console" ? "console.anthropic.com" : "claude.ai"
  const url = new URL(`https://${host}/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPES)
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier, mode }
}

async function exchange(code: string, verifier: string, mode: "max" | "console") {
  const splits = code.split("#")
  const res = await fetch(tokenUrl(mode), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) return { type: "failed" as const }
  const json = (await res.json()) as { refresh_token: string; access_token: string; expires_in: number }
  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
  }
}

async function refresh(
  token: string,
  sdk: PluginInput["client"],
): Promise<{ access: string; refresh: string; expires: number }> {
  log.info("refreshing anthropic access token")
  const body = form({
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: CLIENT_ID,
  })
  const urls = [tokenUrl("max"), tokenUrl("console")]
  let err = ""
  for (const url of urls) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      err = `${url} ${res.status}${text ? ` ${text}` : ""}`
      log.warn("anthropic token refresh attempt failed", { url, status: res.status, body: text })
      continue
    }
    const json = (await res.json()) as { refresh_token: string; access_token: string; expires_in: number }
    const state = {
      type: "oauth" as const,
      refresh: json.refresh_token,
      access: json.access_token,
      expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
    }
    await sdk.auth.set({ path: { id: "anthropic" }, body: state })
    log.info("anthropic token refreshed successfully", { url })
    return state
  }
  log.error("anthropic token refresh failed", { error: err || "all refresh endpoints failed" })
  throw new Error("Token refresh failed: 400")
}

// Single-flight refresh: serializes concurrent callers, re-reads storage on 400 fallback
async function ensure(
  getAuth: () => Promise<{ type: string; access?: string; refresh?: string; expires?: number }>,
  sdk: PluginInput["client"],
): Promise<{ access: string }> {
  const auth = await getAuth()
  if (auth.type !== "oauth") return { access: "" }
  if (auth.access && (auth.expires ?? 0) > Date.now()) return { access: auth.access }

  if (inflight) {
    await inflight.catch(() => {})
    const fresh = await getAuth()
    if (fresh.type === "oauth" && fresh.access && (fresh.expires ?? 0) > Date.now()) return { access: fresh.access }
  }

  inflight = (async () => {
    try {
      await refresh(auth.refresh!, sdk)
    } catch {
      const retry = await getAuth()
      if (retry.type === "oauth" && retry.access && (retry.expires ?? 0) > Date.now()) {
        log.info("anthropic refresh failed but storage has fresh token, using it")
        return
      }
      throw new Error("Token refresh failed and no fresh token in storage")
    } finally {
      inflight = null
    }
  })()

  await inflight
  const result = await getAuth()
  if (result.type !== "oauth") return { access: "" }
  return { access: result.access ?? "" }
}

function rewrite(body: string): string {
  try {
    const parsed = JSON.parse(body)

    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item: { type?: string; text?: string }) => {
        if (item.type !== "text" || !item.text) return item
        return { ...item, text: item.text.replace(SYSTEM_REPLACE_FROM, SYSTEM_REPLACE_TO) }
      })
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: { name?: string }) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }))
    }

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

function merge(existing: string, required: string[]): string {
  return Array.from(
    new Set([
      ...required,
      ...existing
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ]),
  ).join(",")
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    "experimental.chat.system.transform": async (
      ctx: { model?: { providerID?: string } },
      out: { system: string[] },
    ) => {
      if (ctx.model?.providerID !== "anthropic") return
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      out.system.unshift(prefix)
      if (out.system[1]) {
        out.system[1] = prefix + "\n\n" + out.system[1]
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        for (const model of Object.values(provider.models)) {
          ;(model as { cost?: unknown }).cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(req: Request | string | URL, init?: RequestInit) {
            const token = await ensure(
              getAuth as () => Promise<{ type: string; access?: string; refresh?: string; expires?: number }>,
              sdk,
            )
            if (!token.access) return fetch(req, init)

            const opts = init ?? {}

            const hdrs = new Headers()
            if (req instanceof Request) {
              req.headers.forEach((v, k) => hdrs.set(k, v))
            }
            if (opts.headers) {
              if (opts.headers instanceof Headers) {
                opts.headers.forEach((v, k) => hdrs.set(k, v))
              } else if (Array.isArray(opts.headers)) {
                for (const [k, v] of opts.headers as [string, string][]) {
                  if (v !== undefined) hdrs.set(k, String(v))
                }
              } else {
                for (const [k, v] of Object.entries(opts.headers)) {
                  if (v !== undefined) hdrs.set(k, String(v))
                }
              }
            }

            const betas = merge(hdrs.get("anthropic-beta") || "", [
              "oauth-2025-04-20",
              "interleaved-thinking-2025-05-14",
            ])

            hdrs.set("authorization", `Bearer ${token.access}`)
            hdrs.set("anthropic-beta", betas)
            hdrs.set("user-agent", `opencode/${Installation.VERSION_RAW} (oauth, cli)`)
            hdrs.delete("x-api-key")

            let body = opts.body
            if (body && typeof body === "string") {
              body = rewrite(body)
            }

            let target: Request | string | URL = req
            try {
              const parsed = typeof req === "string" || req instanceof URL ? new URL(req.toString()) : new URL(req.url)
              if (parsed.pathname === "/v1/messages" && !parsed.searchParams.has("beta")) {
                parsed.searchParams.set("beta", "true")
                target = req instanceof Request ? new Request(parsed.toString(), req) : parsed
              }
            } catch {}

            const response = await fetch(target, { ...opts, body, headers: hdrs })

            if (response.body) {
              const reader = response.body.getReader()
              const dec = new TextDecoder()
              const enc = new TextEncoder()
              const stream = new ReadableStream({
                async pull(ctrl) {
                  const chunk = await reader.read()
                  if (chunk.done) return ctrl.close()
                  let text = dec.decode(chunk.value, { stream: true })
                  text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
                  ctrl.enqueue(enc.encode(text))
                },
              })
              return new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
            }

            return response
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const auth = await authorize("max")
            return {
              url: auth.url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => exchange(code, auth.verifier, auth.mode),
            }
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const auth = await authorize("console")
            return {
              url: auth.url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => {
                const creds = await exchange(code, auth.verifier, auth.mode)
                if (creds.type === "failed") return creds
                const result = await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${creds.access}`,
                  },
                }).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: "success" as const, key: result.raw_key }
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
