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
