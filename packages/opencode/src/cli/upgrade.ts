import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
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
    const spec = Config.pluginSpecifier(entry)
    const lastAt = spec.lastIndexOf("@")
    const name = lastAt > 0 ? spec.substring(0, lastAt) : spec
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
  const config: Awaited<ReturnType<typeof Config.getGlobal>> = await Config.getGlobal()
  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  Installation.setTrackedPlugins(discoverPlugins(config))

  const [latest] = await Promise.all([
    AppRuntime.runPromise(Installation.Service.use((svc) => svc.latest(method))).catch(() => undefined),
    Installation.checkAllPluginUpdates(),
  ])
  if (!latest) return

  Installation.setLatestUpstream(latest)

  if (Installation.VERSION_RAW === latest) return
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return

  // Fork: always notify, never auto-upgrade — fork binary must be rebuilt manually
  await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
}
