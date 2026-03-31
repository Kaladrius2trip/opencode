import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AnthropicAuthPlugin } from "../../src/plugin/anthropic/index"
import { invalidateCache } from "../../src/plugin/anthropic/credentials"

const fetch0 = globalThis.fetch
const originalCredPath = process.env.CLAUDE_CREDENTIALS_PATH

beforeEach(() => {
  // Isolate tests from real credentials file
  process.env.CLAUDE_CREDENTIALS_PATH = "/tmp/.nonexistent-credentials.json"
  invalidateCache()
})

afterEach(() => {
  globalThis.fetch = fetch0
  if (originalCredPath !== undefined) {
    process.env.CLAUDE_CREDENTIALS_PATH = originalCredPath
  } else {
    delete process.env.CLAUDE_CREDENTIALS_PATH
  }
  invalidateCache()
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
