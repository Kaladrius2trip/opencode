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

  export function parse(providerID: string, headers: Record<string, string>) {
    const has = headers["anthropic-ratelimit-requests-limit"] || headers["anthropic-ratelimit-unified-5h-utilization"]
    if (!has) return

    function num(h: string) {
      const val = Number.parseFloat(headers[h])
      if (!Number.isFinite(val)) return undefined
      return val
    }

    const lim = num("anthropic-ratelimit-requests-limit")
    const rem = num("anthropic-ratelimit-requests-remaining")
    const rst = headers["anthropic-ratelimit-requests-reset"]
    const tlim = num("anthropic-ratelimit-tokens-limit")
    const trem = num("anthropic-ratelimit-tokens-remaining")
    const trst = headers["anthropic-ratelimit-tokens-reset"]
    const irem = num("anthropic-ratelimit-input-tokens-remaining")
    const orem = num("anthropic-ratelimit-output-tokens-remaining")

    const u5h = num("anthropic-ratelimit-unified-5h-utilization")
    const r5h = num("anthropic-ratelimit-unified-5h-reset")
    const s5h = headers["anthropic-ratelimit-unified-5h-status"]
    const u7d = num("anthropic-ratelimit-unified-7d-utilization")
    const r7d = num("anthropic-ratelimit-unified-7d-reset")
    const s7d = headers["anthropic-ratelimit-unified-7d-status"]
    const overall = headers["anthropic-ratelimit-unified-status"]

    const w5h = u5h !== undefined ? { pct: u5h, reset: r5h ?? 0, status: s5h ?? "" } : undefined
    const w7d = u7d !== undefined ? { pct: u7d, reset: r7d ?? 0, status: s7d ?? "" } : undefined
    const util = w5h || w7d ? { window5h: w5h, window7d: w7d, overall } : undefined

    const info: Info = {
      providerID,
      requests: lim !== undefined && rem !== undefined ? { limit: lim, remaining: rem, reset: rst } : undefined,
      tokens: tlim !== undefined && trem !== undefined ? { limit: tlim, remaining: trem, reset: trst } : undefined,
      inputTokens: irem !== undefined ? { remaining: irem } : undefined,
      outputTokens: orem !== undefined ? { remaining: orem } : undefined,
      utilization: util,
      time: Date.now(),
    }

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
