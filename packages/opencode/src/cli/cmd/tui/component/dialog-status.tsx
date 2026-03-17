import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import type { RateLimit } from "@/provider/ratelimit"

export type DialogStatusProps = {}

function label(id: string) {
  if (id === "anthropic" || id.startsWith("anthropic")) return "Claude Code"
  return id
}

function fmtReset(epoch: number) {
  const diff = Math.ceil(epoch - Date.now() / 1000)
  if (diff <= 0) return ""
  if (diff < 3600) return `${Math.ceil(diff / 60)}m`
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    return `${h}h ${m.toString().padStart(2, "0")}m`
  }
  return `${(diff / 86400).toFixed(1)}d`
}

function bar(pct: number, width = 20) {
  const filled = Math.round(pct * width)
  return "[" + "#".repeat(filled) + ".".repeat(width - filled) + "]"
}

function status(info: RateLimit.Info) {
  const windows = [info.utilization?.window5h, info.utilization?.window7d].filter(Boolean)
  const val = windows.reduce((acc, w) => {
    if (w!.status === "denied") return "denied"
    if (w!.status.includes("warning") && acc !== "denied") return "warning"
    return acc
  }, "ok" as string)
  const reset = windows.reduce((min, w) => (w!.reset && w!.reset < min ? w!.reset : min), Infinity)
  return { val, reset }
}

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const limits = createMemo(() => Object.values(sync.data.ratelimit ?? {}))
  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((value) => {
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={Object.keys(sync.data.mcp).length > 0} fallback={<text fg={theme.text}>No MCP Servers</text>}>
        <box>
          <text fg={theme.text}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: theme.success,
                        failed: theme.error,
                        disabled: theme.textMuted,
                        needs_auth: theme.warning,
                        needs_client_registration: theme.error,
                      } as Record<string, typeof theme.success>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                      <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={(item.status as string) === "needs_auth"}>
                        Needs authentication (run: opencode mcp auth {key})
                      </Match>
                      <Match when={(item.status as string) === "needs_client_registration" && item}>
                        {(val) => (val() as { error: string }).error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={theme.text}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.success,
                      error: theme.error,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.text}>No Formatters</text>}>
        <box>
          <text fg={theme.text}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={plugins().length > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
        <box>
          <text fg={theme.text}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={limits().length > 0}>
        <For each={limits()}>
          {(info) => {
            const s = () => status(info)
            return (
              <box>
                <text fg={theme.text}>
                  {label(info.providerID)} Limits <span style={{ fg: theme.textMuted }}>({info.providerID})</span>
                </text>
                <Show when={info.utilization}>
                  <text fg={theme.text}>
                    {"  "}
                    <span
                      style={{
                        fg: s().val === "denied" ? theme.error : s().val === "warning" ? theme.warning : theme.success,
                      }}
                    >
                      {s().val === "denied" ? "✕ DENIED" : s().val === "warning" ? "⚠ WARN" : "● OK"}
                    </span>
                    <Show when={fmtReset(s().reset)}>
                      <span style={{ fg: theme.textMuted }}>
                        {"  resets in "}
                        {fmtReset(s().reset)}
                      </span>
                    </Show>
                  </text>
                </Show>
                <Show when={info.utilization?.window5h}>
                  {(w) => (
                    <text fg={theme.text}>
                      {"  "}5h: {Math.round(w().pct * 100)}% {bar(w().pct)}
                    </text>
                  )}
                </Show>
                <Show when={info.utilization?.window7d}>
                  {(w) => (
                    <text fg={theme.text}>
                      {"  "}7d: {Math.round(w().pct * 100)}% {bar(w().pct)}
                    </text>
                  )}
                </Show>
                <Show when={info.requests}>
                  {(req) => (
                    <text fg={theme.text}>
                      {"  "}RPM: {req().remaining.toLocaleString()} / {req().limit.toLocaleString()} remaining
                    </text>
                  )}
                </Show>
                <Show when={info.tokens}>
                  {(tok) => (
                    <text fg={theme.text}>
                      {"  "}TPM: {tok().remaining.toLocaleString()} / {tok().limit.toLocaleString()} remaining
                    </text>
                  )}
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}
