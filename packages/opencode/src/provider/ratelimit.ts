import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import z from "zod"

export namespace RateLimit {
  export const Info = z
    .object({
      providerID: z.string(),
      requests: z
        .object({
          limit: z.number(),
          remaining: z.number(),
          reset: z.string().optional(),
        })
        .optional(),
      tokens: z
        .object({
          limit: z.number(),
          remaining: z.number(),
          reset: z.string().optional(),
        })
        .optional(),
      inputTokens: z
        .object({
          remaining: z.number(),
        })
        .optional(),
      outputTokens: z
        .object({
          remaining: z.number(),
        })
        .optional(),
      utilization: z
        .object({
          window5h: z
            .object({
              pct: z.number(),
              reset: z.number(),
              status: z.string(),
            })
            .optional(),
          window7d: z
            .object({
              pct: z.number(),
              reset: z.number(),
              status: z.string(),
            })
            .optional(),
          overall: z.string().optional(),
        })
        .optional(),
      time: z.number(),
    })
    .meta({
      ref: "RateLimit",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("ratelimit.updated", Info),
  }

  const state = Instance.state(() => {
    const data: Record<string, Info> = {}
    return data
  })

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

  export function parse(providerID: string, headers: Record<string, string>) {
    function num(h: string) {
      const val = Number.parseFloat(headers[h])
      if (!Number.isFinite(val)) return undefined
      return val
    }

    const parsed = parseAnthropic(headers, num) ?? parseOpenAI(headers, num)
    if (!parsed) return

    const info: Info = { ...parsed, providerID, time: Date.now() }
    Bus.publish(Event.Updated, info)
    state()[providerID] = info
  }

  export function get(providerID: string) {
    return state()[providerID]
  }

  export function list() {
    return state()
  }
}
