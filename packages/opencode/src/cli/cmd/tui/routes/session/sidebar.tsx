import { useSync } from "@tui/context/sync"
import { createMemo, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { RateLimit } from "@/provider/ratelimit"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useKeybind } from "../../context/keybind"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"

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

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
    limits: true,
  })

  const limits = createMemo(() => Object.values(sync.data.ratelimit ?? {}))
  const worst = createMemo(() => (limits().length > 0 ? status(limits()[0]) : { val: "ok", reset: Infinity }))

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const totalInput = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
      cacheHitPercent: totalInput > 0 ? ((last.tokens.cache.read / totalInput) * 100).toFixed(3) : null,
      cacheRead: last.tokens.cache.read,
      cacheWrite: last.tokens.cache.write,
      cacheNew: last.tokens.input,
      cacheInput: totalInput,
      cacheOutput: last.tokens.output,
    }
  })

  const directory = useDirectory()
  const kv = useKV()

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

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
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
              <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
              <text fg={theme.textMuted}>{cost()} spent</text>
            </box>
            <Show when={process.env["OPENCODE_CACHE_AUDIT"] && context()?.cacheHitPercent != null}>
              <box>
                <text fg={theme.text}>
                  <b>Cache Audit</b>
                </text>
                <text fg={theme.textMuted}>{context()!.cacheInput.toLocaleString()} input tokens</text>
                <text fg={theme.textMuted}> {context()!.cacheNew.toLocaleString()} new</text>
                <text fg={theme.textMuted}> {context()!.cacheRead.toLocaleString()} cache read</text>
                <text fg={theme.textMuted}> {context()!.cacheWrite.toLocaleString()} cache write</text>
                <text fg={theme.textMuted}>{context()!.cacheHitPercent}% hit rate</text>
                <text fg={theme.textMuted}>{context()!.cacheOutput.toLocaleString()} output tokens</text>
              </box>
            </Show>
            <Show when={limits().length > 0}>
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("limits", !expanded.limits)}>
                  <text fg={theme.text}>{expanded.limits ? "▼" : "▶"}</text>
                  <text fg={theme.text}>
                    <b>{limits().length === 1 ? label(limits()[0].providerID) + " Limits" : "Limits"}</b>
                    <Show when={!expanded.limits && limits().length > 0}>
                      {(() => {
                        const s = status(limits()[0])
                        return (
                          <span
                            style={{
                              fg:
                                s.val === "denied" ? theme.error : s.val === "warning" ? theme.warning : theme.success,
                            }}
                          >
                            {" "}
                            {s.val === "denied" ? "✕ DENIED" : s.val === "warning" ? "⚠ WARN" : "● OK"}
                          </span>
                        )
                      })()}
                    </Show>
                  </text>
                </box>
                <Show when={expanded.limits}>
                  <For each={limits()}>
                    {(info) => (
                      <box>
                        <Show when={limits().length > 1}>
                          <text fg={theme.textMuted}>
                            {"  "}
                            {label(info.providerID)}
                          </text>
                        </Show>
                        <Show when={info.utilization?.window5h}>
                          {(w) => {
                            const pct = () => Math.round(w().pct * 100)
                            const filled = () => Math.round(w().pct * 12)
                            return (
                              <text fg={theme.text}>
                                {"  "}5h {pct().toString().padStart(3)}%{" "}
                                {"[" + "#".repeat(filled()) + ".".repeat(12 - filled()) + "]"}{" "}
                                <span
                                  style={{
                                    fg:
                                      w().status === "denied"
                                        ? theme.error
                                        : w().status.includes("warning")
                                          ? theme.warning
                                          : theme.success,
                                  }}
                                >
                                  {w().status === "denied" ? "DENY" : w().status.includes("warning") ? "WARN" : "OK"}
                                </span>
                                <Show when={fmtReset(w().reset)}>
                                  <span style={{ fg: theme.textMuted }}> {fmtReset(w().reset)}</span>
                                </Show>
                              </text>
                            )
                          }}
                        </Show>
                        <Show when={info.utilization?.window7d}>
                          {(w) => {
                            const pct = () => Math.round(w().pct * 100)
                            const filled = () => Math.round(w().pct * 12)
                            return (
                              <text fg={theme.text}>
                                {"  "}7d {pct().toString().padStart(3)}%{" "}
                                {"[" + "#".repeat(filled()) + ".".repeat(12 - filled()) + "]"}{" "}
                                <span
                                  style={{
                                    fg:
                                      w().status === "denied"
                                        ? theme.error
                                        : w().status.includes("warning")
                                          ? theme.warning
                                          : theme.success,
                                  }}
                                >
                                  {w().status === "denied" ? "DENY" : w().status.includes("warning") ? "WARN" : "OK"}
                                </span>
                                <Show when={fmtReset(w().reset)}>
                                  <span style={{ fg: theme.textMuted }}> {fmtReset(w().reset)}</span>
                                </Show>
                              </text>
                            )
                          }}
                        </Show>
                        <Show when={info.requests}>
                          {(req) => (
                            <text fg={theme.textMuted}>
                              {"  "}RPM {req().remaining}/{req().limit}
                            </text>
                          )}
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
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
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
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
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                </Show>
              </box>
            </Show>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff() || []}>
                    {(item) => {
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="none">
                            {item.file}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
            {Installation.getLatestUpstream() && Installation.getLatestUpstream() !== Installation.VERSION_RAW ? (
              <span style={{ fg: theme.warning }}>{` ↑ ${Installation.getLatestUpstream()}`}</span>
            ) : null}
          </text>
          <For each={[...Installation.getTrackedPlugins()]}>
            {(plugin) => (
              <text fg={theme.textMuted}>
                <span style={{ fg: theme.success }}>•</span>{" "}
                <span>
                  {plugin.name} {plugin.local}
                </span>
                {plugin.latest && plugin.latest !== plugin.local && !plugin.builtin ? (
                  <span style={{ fg: theme.warning }}>{` ↑ ${plugin.latest}`}</span>
                ) : plugin.builtin && plugin.latest ? (
                  <span style={{ fg: theme.textMuted }}>{` npm:${plugin.latest}`}</span>
                ) : null}
              </text>
            )}
          </For>
        </box>
      </box>
    </Show>
  )
}
