import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.anthropic" })

const DEBUG = process.env.CLAUDE_AUTH_DEBUG === "1"

const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "key",
  "apiKey",
  "authorization",
])

function redact(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(redact)
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v)
  }
  return result
}

function debugLog(category: string, message: string, data?: Record<string, unknown>) {
  if (!DEBUG) return
  const entry = {
    ts: new Date().toISOString(),
    cat: category,
    msg: message,
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  }
  process.stderr.write(JSON.stringify(entry) + "\n")
}

export const logger = {
  debug: debugLog,
  info: (msg: string, data?: Record<string, unknown>) => log.info(msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log.warn(msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log.error(msg, data),
}
