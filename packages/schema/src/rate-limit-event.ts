export * as RateLimitEvent from "./rate-limit-event"

import { Schema } from "effect"
import { Event } from "./event"

const Dimension = Schema.Struct({
  limit: Schema.Number,
  remaining: Schema.Number,
  reset: Schema.optional(Schema.String),
})

const Window = Schema.Struct({
  pct: Schema.Number,
  reset: Schema.Number,
  status: Schema.String,
})

export const Info = Schema.Struct({
  providerID: Schema.String,
  requests: Schema.optional(Dimension),
  tokens: Schema.optional(Dimension),
  inputTokens: Schema.optional(Schema.Struct({ remaining: Schema.Number })),
  outputTokens: Schema.optional(Schema.Struct({ remaining: Schema.Number })),
  utilization: Schema.optional(
    Schema.Struct({
      window5h: Schema.optional(Window),
      window7d: Schema.optional(Window),
      overall: Schema.optional(Schema.String),
    }),
  ),
  time: Schema.Number,
})

export type Info = typeof Info.Type

export const Updated = Event.define({
  type: "ratelimit.updated",
  schema: Info.fields,
})

export const Definitions = Event.inventory(Updated)
