import { Bus } from "@/bus"
import { Installation } from "@/installation"
import { readFileSync } from "fs"
import { join } from "path"

function discoverPlugins(): Installation.PluginInfo[] {
  const plugins: Installation.PluginInfo[] = []
  const home = process.env.HOME || "~"
  const cacheDir = join(home, ".cache", "opencode", "node_modules")

  plugins.push({
    name: "anthropic-auth",
    npmName: "opencode-anthropic-auth",
    local: "0.1.0 (fork)",
    builtin: true,
  })

  let configPlugins: string[] = []
  try {
    const raw = readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf-8")
    configPlugins = JSON.parse(raw).plugin || []
  } catch {}

  for (const entry of configPlugins) {
    const lastAt = entry.lastIndexOf("@")
    const name = lastAt > 0 ? entry.substring(0, lastAt) : entry
    if (name.includes("opencode-openai-codex-auth") || name.includes("opencode-copilot-auth")) continue

    let local = "?"
    try {
      const pkg = JSON.parse(readFileSync(join(cacheDir, name, "package.json"), "utf-8"))
      local = pkg.version || "?"
    } catch {}

    plugins.push({
      name: name.replace(/^opencode-/, ""),
      npmName: name,
      local,
    })
  }

  return plugins
}

export async function upgrade() {
  Installation.setTrackedPlugins(discoverPlugins())

  const [latest] = await Promise.all([
    Installation.latest(await Installation.method()).catch(() => undefined),
    Installation.checkAllPluginUpdates(),
  ])

  if (!latest) return
  Installation.setLatestUpstream(latest)
  if (Installation.VERSION_RAW === latest) return

  await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
}
