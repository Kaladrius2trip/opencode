import { useSync } from "@tui/context/sync"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { Installation } from "@/installation"
import { TuiPluginRuntime } from "../../plugin"
import type { RateLimit } from "@/provider/ratelimit"

import { getScrollAcceleration } from "../../util/scroll"

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

function bar(pct: number, width = 16) {
  const filled = Math.round(pct * width)
  return "▓".repeat(filled) + "░".repeat(width - filled)
}

function limStatus(info: RateLimit.Info) {
  const windows = [info.utilization?.window5h, info.utilization?.window7d].filter(Boolean)
  const val = windows.reduce((acc, w) => {
    if (w!.status === "denied") return "denied"
    if (w!.status.includes("warning") && acc !== "denied") return "warning"
    return acc
  }, "ok" as string)
  const reset = windows.reduce((min, w) => (w!.reset && w!.reset < min ? w!.reset : min), Infinity)
  return { val, reset }
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
            <SidebarLimits />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{Installation.VERSION}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  "opencode-go": "Go",
  "opencode-zen": "Zen",
  google: "Gemini",
  "github-copilot": "Copilot",
}

function providerLabel(id: string) {
  for (const [prefix, name] of Object.entries(PROVIDER_LABELS)) {
    if (id === prefix || id.startsWith(prefix)) return name
  }
  return id
}

function pctColor(pct: number, theme: ReturnType<typeof useTheme>["theme"]) {
  if (pct > 0.9) return theme.error
  if (pct > 0.7) return theme.warning
  return theme.textMuted
}

function SidebarLimits() {
  const sync = useSync()
  const { theme } = useTheme()
  const limits = createMemo(() => Object.values(sync.data.ratelimit ?? {}))

  return (
    <For each={limits()}>
      {(info) => {
        const s = () => limStatus(info)
        const color = () => (s().val === "denied" ? theme.error : s().val === "warning" ? theme.warning : theme.success)
        const hasWindows = () => info.utilization?.window5h || info.utilization?.window7d
        return (
          <box gap={0}>
            <box flexDirection="row" gap={1}>
              <text fg={color()}>{s().val === "denied" ? "✕" : s().val === "warning" ? "⚠" : "●"}</text>
              <text fg={theme.text}>
                <b>{providerLabel(info.providerID)}</b>
              </text>
              <Show when={fmtReset(s().reset)}>
                <text fg={theme.textMuted}>{fmtReset(s().reset)}</text>
              </Show>
            </box>
            <Show when={info.utilization?.window5h}>
              {(w) => (
                <text fg={theme.text}>
                  {"  "}5h {bar(w().pct)}{" "}
                  <span style={{ fg: pctColor(w().pct, theme) }}>{Math.round(w().pct * 100)}%</span>
                </text>
              )}
            </Show>
            <Show when={info.utilization?.window7d}>
              {(w) => (
                <text fg={theme.text}>
                  {"  "}7d {bar(w().pct)}{" "}
                  <span style={{ fg: pctColor(w().pct, theme) }}>{Math.round(w().pct * 100)}%</span>
                </text>
              )}
            </Show>
            <Show when={!hasWindows() && info.requests}>
              {(req) => {
                const pct = () => 1 - req().remaining / Math.max(req().limit, 1)
                return (
                  <text fg={theme.text}>
                    {"  "}RPM {bar(pct())}{" "}
                    <span style={{ fg: pctColor(pct(), theme) }}>
                      {req().remaining}/{req().limit}
                    </span>
                  </text>
                )
              }}
            </Show>
            <Show when={!hasWindows() && info.tokens}>
              {(tok) => {
                const pct = () => 1 - tok().remaining / Math.max(tok().limit, 1)
                return (
                  <text fg={theme.text}>
                    {"  "}TPM {bar(pct())}{" "}
                    <span style={{ fg: pctColor(pct(), theme) }}>{(tok().remaining / 1000).toFixed(0)}k</span>
                  </text>
                )
              }}
            </Show>
          </box>
        )
      }}
    </For>
  )
}
