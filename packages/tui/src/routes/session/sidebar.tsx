import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import type { RateLimitEvent } from "@opencode-ai/schema/rate-limit-event"

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

function limitStatus(info: RateLimitEvent.Info) {
  const windows = [info.utilization?.window5h, info.utilization?.window7d].filter(
    (window): window is NonNullable<typeof window> => window !== undefined,
  )
  const value = windows.reduce((result, window) => {
    if (window.status === "denied") return "denied"
    if (window.status.includes("warning") && result !== "denied") return "warning"
    return result
  }, "ok")
  const reset = windows.reduce((minimum, window) => (window.reset < minimum ? window.reset : minimum), Infinity)
  return { value, reset }
}

function SidebarLimits() {
  const sync = useSync()
  const { theme } = useTheme()
  const limits = createMemo(() => Object.values(sync.data.ratelimit))

  return (
    <Show when={limits().length > 0}>
      <box gap={1} paddingTop={1}>
        <text fg={theme.textMuted}>Rate limits</text>
        <For each={limits()}>
          {(info) => {
            const status = () => limitStatus(info)
            return (
              <box>
                <text fg={theme.text}>
                  <b>{info.providerID}</b>{" "}
                  <span
                    style={{
                      fg:
                        status().value === "denied"
                          ? theme.error
                          : status().value === "warning"
                            ? theme.warning
                            : theme.success,
                    }}
                  >
                    {status().value === "denied" ? "DENIED" : status().value === "warning" ? "WARN" : "OK"}
                  </span>
                </text>
                <Show when={info.utilization?.window5h}>
                  {(window) => (
                    <text fg={theme.textMuted}>
                      5h {Math.round(window().pct * 100)}% {bar(window().pct)} {fmtReset(window().reset)}
                    </text>
                  )}
                </Show>
                <Show when={info.utilization?.window7d}>
                  {(window) => (
                    <text fg={theme.textMuted}>
                      7d {Math.round(window().pct * 100)}% {bar(window().pct)} {fmtReset(window().reset)}
                    </text>
                  )}
                </Show>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
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
            <pluginRuntime.Slot
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
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
            <SidebarLimits />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
