import { getModelBetas } from "./model-config"

export const BASE_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "adaptive-thinking-2026-01-28",
]

// Only context-1m is excluded progressively; interleaved-thinking is a base beta
// and must never be removed.
const LONG_CONTEXT_BETAS = [
  "context-1m-2025-08-07",
]

const LONG_CONTEXT_INDICATORS = ["context", "1m", "token limit", "too many tokens"]

export function isLongContextEnabled(): boolean {
  return process.env.ANTHROPIC_ENABLE_1M_CONTEXT === "true"
}

/** Merge base + model + long-context + existing header betas, deduplicated */
export function mergeBetas(existingHeader: string, modelId?: string): string {
  const betas = [...BASE_BETAS]
  if (modelId) betas.push(...getModelBetas(modelId))
  if (isLongContextEnabled()) betas.push(...LONG_CONTEXT_BETAS)

  return Array.from(
    new Set([
      ...betas,
      ...existingHeader
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ]),
  ).join(",")
}

/** Check if an error body indicates a long-context issue */
export function isLongContextError(body: string): boolean {
  const lower = body.toLowerCase()
  return LONG_CONTEXT_INDICATORS.some((indicator) => lower.includes(indicator))
}

/**
 * Progressive exclusion: returns new beta header with one long-context beta removed.
 * Returns null if no more long-context betas to remove.
 */
export function excludeNextLongContextBeta(currentHeader: string): string | null {
  const parts = currentHeader.split(",").map((b) => b.trim())
  for (const lcBeta of LONG_CONTEXT_BETAS) {
    const idx = parts.indexOf(lcBeta)
    if (idx !== -1) {
      parts.splice(idx, 1)
      return parts.filter(Boolean).join(",")
    }
  }
  return null
}
