import { execSync } from "node:child_process"

const DEFAULT_CLI_VERSION = "2.1.87"

let _cliVersion: string | null = null

export function cliVersion(): string {
  if (!_cliVersion) {
    try {
      const out = execSync("claude --version 2>/dev/null", { timeout: 5000 }).toString().trim()
      const match = out.match(/^([\d.]+)/)
      _cliVersion = match?.[1] ?? DEFAULT_CLI_VERSION
    } catch {
      _cliVersion = DEFAULT_CLI_VERSION
    }
  }
  return _cliVersion
}

export function userAgent(): string {
  return `claude-cli/${cliVersion()} (external, cli)`
}

export function billingHeader(model?: string): string {
  return JSON.stringify({
    cli_version: cliVersion(),
    ...(model ? { model } : {}),
  })
}

/** Extra beta flags for specific model families */
export function getModelBetas(modelId: string): string[] {
  if (modelId.includes("4-6")) {
    return ["effort-2025-11-24"]
  }
  return []
}
