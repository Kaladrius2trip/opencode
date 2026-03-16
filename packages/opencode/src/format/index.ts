import { Bus } from "../bus"
import { File } from "../file"
import { Log } from "../util/log"
import path from "path"
import z from "zod"

import * as Formatter from "./formatter"
import { Config } from "../config/config"
import { mergeDeep } from "remeda"
import { Instance } from "../project/instance"
import { Process } from "../util/process"
import { InstanceContext } from "@/effect/instance-context"
import { Effect, Layer, ServiceMap } from "effect"
import { runPromiseInstance } from "@/effect/runtime"

const log = Log.create({ service: "format" })

export namespace Format {
  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  export async function init() {
    return runPromiseInstance(FormatService.use((s) => s.init()))
  }

  export async function status() {
    return runPromiseInstance(FormatService.use((s) => s.status()))
  }
}

export namespace FormatService {
  export interface Service {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<Format.Status[]>
  }
}

export class FormatService extends ServiceMap.Service<FormatService, FormatService.Service>()("@opencode/Format") {
  static readonly layer = Layer.effect(
    FormatService,
    Effect.gen(function* () {
      const instance = yield* InstanceContext

      const cache: Record<string, string[] | false> = {}
      const formatters: Record<string, Formatter.Info> = {}

      const cfg = yield* Effect.promise(() => Config.get())

      if (cfg.formatter !== false) {
        for (const item of Object.values(Formatter)) {
          formatters[item.name] = item
        }
        for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
          if (item.disabled) {
            delete formatters[name]
            continue
          }
          const result = mergeDeep(formatters[name] ?? {}, {
            extensions: [],
            ...item,
          }) as Formatter.Info

          result.enabled = async () => item.command ?? false
          result.name = name
          formatters[name] = result
        }
      } else {
        log.info("all formatters are disabled")
      }

      async function resolveCommand(item: Formatter.Info) {
        let command = cache[item.name]
        if (command === undefined) {
          command = await item.enabled()
          cache[item.name] = command
        }
        return command
      }

      async function getFormatter(ext: string) {
        const result: { info: Formatter.Info; command: string[] }[] = []
        for (const item of Object.values(formatters)) {
          log.info("checking", { name: item.name, ext })
          if (!item.extensions.includes(ext)) continue
          const command = await resolveCommand(item)
          if (!command) continue
          log.info("enabled", { name: item.name, ext })
          result.push({ info: item, command })
        }
        return result
      }

      const unsubscribe = Bus.subscribe(
        File.Event.Edited,
        Instance.bind(async (payload) => {
          const file = payload.properties.file
          log.info("formatting", { file })
          const ext = path.extname(file)

          for (const { info, command } of await getFormatter(ext)) {
            log.info("running", { command })
            try {
              const proc = Process.spawn(
                command.map((x) => x.replace("$FILE", file)),
                {
                  cwd: instance.directory,
                  env: { ...process.env, ...info.environment },
                  stdout: "ignore",
                  stderr: "ignore",
                },
              )
              const exit = await proc.exited
              if (exit !== 0)
                log.error("failed", {
                  command,
                  ...info.environment,
                })
            } catch (error) {
              log.error("failed to format file", {
                error,
                command,
                ...info.environment,
                file,
              })
            }
          }
        }),
      )

      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
      log.info("init")

      const init = Effect.fn("FormatService.init")(function* () {})

      const status = Effect.fn("FormatService.status")(function* () {
        const result: Format.Status[] = []
        for (const formatter of Object.values(formatters)) {
          const command = yield* Effect.promise(() => resolveCommand(formatter))
          result.push({
            name: formatter.name,
            extensions: formatter.extensions,
            enabled: !!command,
          })
        }
        return result
      })

      return FormatService.of({ init, status })
    }),
  )
}
