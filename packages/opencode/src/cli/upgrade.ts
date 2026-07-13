import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (InstallationVersion === latest) return
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Installation.Event.UpdateAvailable.type,
      properties: { version: latest },
    },
  })
}
