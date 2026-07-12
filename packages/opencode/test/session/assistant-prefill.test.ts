import { expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { stripAssistantPrefill } from "@/session/llm/assistant-prefill"

test("strips only the trailing assistant prefill", () => {
  // Given
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second" },
    { role: "assistant", content: "prefill" },
  ] satisfies ModelMessage[]

  // When
  const result = stripAssistantPrefill(messages)

  // Then
  expect(result).toEqual(messages.slice(0, -1))
})
