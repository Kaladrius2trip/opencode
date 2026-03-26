import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { existsSync, readFileSync } from "fs"
import path from "path"

function discoverPlugins(config: Awaited<ReturnType<typeof Config.getGlobal>>): Installation.PluginInfo[] {
  const plugins: Installation.PluginInfo[] = []
  const cacheDir = path.join(Global.Path.cache, "node_modules")

  plugins.push({
    name: "anthropic-auth",
    npmName: "opencode-anthropic-auth",
    local: "0.1.0 (fork)",
    builtin: true,
  })

  const configPlugins = config.plugin ?? []

  for (const entry of configPlugins) {
    const lastAt = entry.lastIndexOf("@")
    const name = lastAt > 0 ? entry.substring(0, lastAt) : entry
    if (name.includes("opencode-openai-codex-auth") || name.includes("opencode-copilot-auth")) continue

    let local = "?"
    try {
      const pkgPath = path.join(cacheDir, name, "package.json")
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
        local = pkg.version || "?"
      }
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
  const config = await Config.getGlobal()
  const method = await Installation.method()
  Installation.setTrackedPlugins(discoverPlugins(config))

  const [latest] = await Promise.all([
    Installation.latest(method).catch(() => undefined),
    Installation.checkAllPluginUpdates(),
  ])
  if (!latest) return

  Installation.setLatestUpstream(latest)

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (Installation.VERSION_RAW === latest) return
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return

  const kind = Installation.getReleaseType(Installation.VERSION, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(() => {})
}
