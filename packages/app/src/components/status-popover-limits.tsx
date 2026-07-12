import { Tabs } from "@opencode-ai/ui/tabs"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import type { RateLimitInfo } from "@/context/global-sync/types"

function resetDuration(epoch: number) {
  const diff = Math.ceil(epoch - Date.now() / 1000)
  if (diff <= 0) return
  if (diff < 3600) return `${Math.ceil(diff / 60)}m`
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600)
    const minutes = Math.floor((diff % 3600) / 60)
    return `${hours}h${minutes.toString().padStart(2, "0")}m`
  }
  return `${(diff / 86400).toFixed(1)}d`
}

function Progress(props: { value: number }) {
  const percent = () => Math.min(100, Math.round(props.value * 100))
  return (
    <div class="h-1.5 w-full rounded-full bg-surface-base overflow-hidden">
      <div
        class="h-full rounded-full transition-all"
        classList={{
          "bg-icon-success-base": percent() < 70,
          "bg-icon-warning-base": percent() >= 70 && percent() < 90,
          "bg-icon-critical-base": percent() >= 90,
        }}
        style={{ width: `${percent()}%` }}
      />
    </div>
  )
}

function UtilizationRow(props: {
  label: string
  window: NonNullable<NonNullable<RateLimitInfo["utilization"]>["window5h"]>
}) {
  const language = useLanguage()
  const reset = () => resetDuration(props.window.reset)
  const badge = () => {
    if (props.window.status === "denied") return "dialog.limits.status.denied" as const
    if (props.window.status.includes("warning")) return "dialog.limits.status.allowed_warning" as const
    return "dialog.limits.status.allowed" as const
  }
  return (
    <div class="flex flex-col gap-1 px-2 py-1">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-12-regular text-text-base">{props.label}</span>
          <span
            class="text-10-regular px-1 rounded"
            classList={{
              "bg-surface-success text-icon-success-base": props.window.status === "allowed",
              "bg-surface-warning text-icon-warning-base": props.window.status.includes("warning"),
              "bg-surface-critical text-icon-critical-base": props.window.status === "denied",
            }}
          >
            {language.t(badge())}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <Show when={reset()}>
            {(value) => (
              <span class="text-11-regular text-text-weaker">
                {language.t("dialog.limits.reset")} {value()}
              </span>
            )}
          </Show>
          <span class="text-12-regular text-text-weak">{Math.min(100, Math.round(props.window.pct * 100))}%</span>
        </div>
      </div>
      <Progress value={props.window.pct} />
    </div>
  )
}

function DimensionRow(props: {
  label: string
  dimension: NonNullable<RateLimitInfo["requests"]>
}) {
  const language = useLanguage()
  const reset = () => {
    if (!props.dimension.reset) return
    const diff = Math.ceil((new Date(props.dimension.reset).getTime() - Date.now()) / 1000)
    return diff > 0 ? `${diff}s` : undefined
  }
  const used = () => (props.dimension.limit - props.dimension.remaining) / props.dimension.limit
  return (
    <div class="flex flex-col gap-1 px-2 py-1">
      <div class="flex items-center justify-between">
        <span class="text-12-regular text-text-base">{props.label}</span>
        <div class="flex items-center gap-2">
          <Show when={reset()}>
            {(value) => (
              <span class="text-11-regular text-text-weaker">
                {language.t("dialog.limits.reset")} {value()}
              </span>
            )}
          </Show>
          <span class="text-12-regular text-text-weak">
            {props.dimension.remaining.toLocaleString()} / {props.dimension.limit.toLocaleString()}
          </span>
        </div>
      </div>
      <Progress value={used()} />
    </div>
  )
}

export function StatusPopoverLimitsTrigger() {
  const sync = useSync()
  const language = useLanguage()
  const count = createMemo(() => Object.keys(sync().data.ratelimit).length)
  return (
    <Tabs.Trigger value="limits" data-slot="tab" class="text-12-regular">
      {count() > 0 ? `${count()} ` : ""}
      {language.t("status.popover.tab.limits")}
    </Tabs.Trigger>
  )
}

export function StatusPopoverLimitsContent() {
  const sync = useSync()
  const language = useLanguage()
  const limits = createMemo(() => Object.values(sync().data.ratelimit))
  return (
    <Tabs.Content value="limits">
      <div class="flex flex-col px-2 pb-2">
        <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
          <Show
            when={limits().length > 0}
            fallback={<div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.limits.empty")}</div>}
          >
            <For each={limits()}>
              {(info) => (
                <div class="flex flex-col gap-1 py-1">
                  <span class="text-12-medium text-text-strong px-2">{info.providerID}</span>
                  <Show when={info.utilization?.window5h}>
                    {(window) => <UtilizationRow label={language.t("dialog.limits.window5h")} window={window()} />}
                  </Show>
                  <Show when={info.utilization?.window7d}>
                    {(window) => <UtilizationRow label={language.t("dialog.limits.window7d")} window={window()} />}
                  </Show>
                  <Show when={info.requests}>
                    {(dimension) => <DimensionRow label={language.t("dialog.limits.requests")} dimension={dimension()} />}
                  </Show>
                  <Show when={info.tokens}>
                    {(dimension) => <DimensionRow label={language.t("dialog.limits.tokens")} dimension={dimension()} />}
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Tabs.Content>
  )
}
