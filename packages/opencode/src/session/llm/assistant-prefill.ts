import type { ModelMessage } from "ai"

export function stripAssistantPrefill(messages: ModelMessage[]): ModelMessage[] {
  return messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages
}
