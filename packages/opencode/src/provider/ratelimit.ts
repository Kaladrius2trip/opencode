import { RateLimitEvent } from "@opencode-ai/schema/rate-limit-event"

export namespace RateLimit {
  export const Info = RateLimitEvent.Info
  export type Info = RateLimitEvent.Info
  export const Event = RateLimitEvent

  function parseAnthropic(headers: Record<string, string>, num: (h: string) => number | undefined): Info | undefined {
    const has = headers["anthropic-ratelimit-requests-limit"] || headers["anthropic-ratelimit-unified-5h-utilization"]
    if (!has) return undefined

    const u5h = num("anthropic-ratelimit-unified-5h-utilization")
    const r5h = num("anthropic-ratelimit-unified-5h-reset")
    const s5h = headers["anthropic-ratelimit-unified-5h-status"]
    const u7d = num("anthropic-ratelimit-unified-7d-utilization")
    const r7d = num("anthropic-ratelimit-unified-7d-reset")
    const s7d = headers["anthropic-ratelimit-unified-7d-status"]
    const overall = headers["anthropic-ratelimit-unified-status"]

    const w5h = u5h !== undefined ? { pct: u5h, reset: r5h ?? 0, status: s5h ?? "" } : undefined
    const w7d = u7d !== undefined ? { pct: u7d, reset: r7d ?? 0, status: s7d ?? "" } : undefined

    const lim = num("anthropic-ratelimit-requests-limit")
    const rem = num("anthropic-ratelimit-requests-remaining")
    const rst = headers["anthropic-ratelimit-requests-reset"]
    const tlim = num("anthropic-ratelimit-tokens-limit")
    const trem = num("anthropic-ratelimit-tokens-remaining")
    const trst = headers["anthropic-ratelimit-tokens-reset"]

    return {
      providerID: "",
      requests: lim !== undefined && rem !== undefined ? { limit: lim, remaining: rem, reset: rst } : undefined,
      tokens: tlim !== undefined && trem !== undefined ? { limit: tlim, remaining: trem, reset: trst } : undefined,
      inputTokens:
        num("anthropic-ratelimit-input-tokens-remaining") !== undefined
          ? { remaining: num("anthropic-ratelimit-input-tokens-remaining")! }
          : undefined,
      outputTokens:
        num("anthropic-ratelimit-output-tokens-remaining") !== undefined
          ? { remaining: num("anthropic-ratelimit-output-tokens-remaining")! }
          : undefined,
      utilization: w5h || w7d ? { window5h: w5h, window7d: w7d, overall } : undefined,
      time: 0,
    }
  }

  function parseOpenAI(headers: Record<string, string>, num: (h: string) => number | undefined): Info | undefined {
    const has = headers["x-ratelimit-limit-requests"] || headers["x-ratelimit-limit-tokens"]
    if (!has) return undefined

    const lim = num("x-ratelimit-limit-requests")
    const rem = num("x-ratelimit-remaining-requests")
    const rst = headers["x-ratelimit-reset-requests"]
    const tlim = num("x-ratelimit-limit-tokens")
    const trem = num("x-ratelimit-remaining-tokens")
    const trst = headers["x-ratelimit-reset-tokens"]

    return {
      providerID: "",
      requests: lim !== undefined && rem !== undefined ? { limit: lim, remaining: rem, reset: rst } : undefined,
      tokens: tlim !== undefined && trem !== undefined ? { limit: tlim, remaining: trem, reset: trst } : undefined,
      utilization: undefined,
      time: 0,
    }
  }

  export function parse(providerID: string, headers: Record<string, string>): Info | undefined {
    function num(h: string) {
      const val = Number.parseFloat(headers[h])
      if (!Number.isFinite(val)) return undefined
      return val
    }

    const parsed = parseAnthropic(headers, num) ?? parseOpenAI(headers, num)
    if (!parsed) return

    return { ...parsed, providerID, time: Date.now() }
  }
}
