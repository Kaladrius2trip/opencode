import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { loadCredentials, invalidateCache, startAuthSync } from "./credentials"
import { createFetch } from "./fetch"
import { SYSTEM_REPLACE_TO } from "./transforms"
import { logger } from "./logger"
import { execSync } from "node:child_process"

/** Force Claude CLI to refresh, then re-read credentials */
function refreshViaClaudeCli(): ReturnType<typeof loadCredentials> {
  try {
    logger.info("triggering Claude CLI to refresh token")
    execSync("claude --print --model claude-haiku-4 ping", { timeout: 30_000, stdio: "pipe" })
    invalidateCache()
    return loadCredentials()
  } catch {
    logger.warn("Claude CLI refresh trigger failed")
    return null
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    "experimental.chat.system.transform": async (
      ctx: { model?: { providerID?: string } },
      out: { system: string[] },
    ) => {
      if (!ctx.model?.providerID?.startsWith("anthropic")) return
      const prefix = SYSTEM_REPLACE_TO
      if (out.system.length > 0 && !out.system[0].startsWith(prefix)) {
        out.system[0] = prefix + "\n\n" + out.system[0]
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const id = (getAuth as typeof getAuth & { providerID?: string }).providerID ?? "anthropic"
        let auth = await getAuth()

        // Auto-import Claude CLI credentials if no valid OAuth token exists
        if (auth.type !== "oauth" || !auth.access || (auth.expires ?? 0) < Date.now()) {
          const cliCreds = loadCredentials()
          if (cliCreds && cliCreds.refresh && cliCreds.expires > Date.now()) {
            logger.info("auto-importing Claude CLI credentials", {
              expires: new Date(cliCreds.expires).toISOString(),
            })
            await sdk.auth.set({
              path: { id },
              body: {
                type: "oauth" as const,
                access: cliCreds.access,
                refresh: cliCreds.refresh,
                expires: cliCreds.expires,
              },
            })
            auth = await getAuth()
          }
        }

        if (auth.type !== "oauth") return {}

        // Set costs to 0 (billing through Claude Code subscription)
        for (const model of Object.values(provider.models)) {
          ;(model as { cost?: unknown }).cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        // Start background auth.json sync
        startAuthSync(sdk, id, getAuth as () => Promise<{ type: string; accountId?: string; enterpriseUrl?: string }>)

        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: createFetch(
            id,
            getAuth as () => Promise<{ type: string; access?: string; refresh?: string; expires?: number; accountId?: string; enterpriseUrl?: string }>,
            sdk,
          ),
        }
      },
      methods: [
        {
          label: "Claude Code (auto)",
          type: "oauth" as const,
          authorize: async () => {
            return {
              url: "",
              instructions: "Importing credentials from Claude CLI...",
              method: "auto" as const,
              callback: async () => {
                let creds = loadCredentials()
                if (!creds || !creds.refresh || creds.expires < Date.now()) {
                  creds = refreshViaClaudeCli()
                }
                if (!creds || !creds.refresh) {
                  return { type: "failed" as const }
                }
                return {
                  type: "success" as const,
                  access: creds.access,
                  refresh: creds.refresh,
                  expires: creds.expires,
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
