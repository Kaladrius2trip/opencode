import { afterEach, describe, expect, test } from "bun:test"
import { AnthropicAuthPlugin } from "../../src/plugin/anthropic"

const fetch0 = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetch0
})

describe("AnthropicAuthPlugin", () => {
  test("refresh falls back to console token endpoint with form body", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const state: { access?: string; refresh?: string } = {}

    globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
      const url = req instanceof Request ? req.url : req.toString()
      calls.push({ url, init })

      if (url === "https://claude.ai/oauth/token") {
        return new Response("bad refresh", { status: 400 })
      }
      if (url === "https://console.anthropic.com/oauth/token") {
        return Response.json({
          refresh_token: "refresh-2",
          access_token: "access-2",
          expires_in: 3600,
        })
      }
      return Response.json({ ok: true })
    }) as typeof fetch

    const plugin = await AnthropicAuthPlugin({
      client: {
        auth: {
          set: async (input: { body: { access: string; refresh: string } }) => {
            state.access = input.body.access
            state.refresh = input.body.refresh
          },
        },
      },
      project: {},
      directory: "/tmp",
      worktree: "/tmp",
      serverUrl: new URL("https://example.com"),
      $: {},
    } as unknown as Parameters<typeof AnthropicAuthPlugin>[0])

    const auth = plugin.auth
    if (!auth?.loader) throw new Error("auth loader missing")

    const cfg = await auth.loader(async () => ({ type: "oauth", access: "", refresh: "refresh-1", expires: 0 }), {
      models: { claude: {} },
    } as unknown as Parameters<NonNullable<typeof auth.loader>>[1])

    await cfg.fetch?.("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
      headers: {
        "x-api-key": "dummy",
      },
    })

    expect(calls[0]?.url).toBe("https://claude.ai/oauth/token")
    expect(calls[1]?.url).toBe("https://console.anthropic.com/oauth/token")
    expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded")
    expect(calls[0]?.init?.body).toBe(
      "grant_type=refresh_token&refresh_token=refresh-1&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    )
    expect(state).toEqual({
      access: "access-2",
      refresh: "refresh-2",
    })
  })
})
