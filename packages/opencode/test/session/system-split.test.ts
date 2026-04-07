import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"

describe("session.llm.prompts", () => {
  test("splits agent prompt from dynamic system content", () => {
    const system = LLM.prompts({
      prompt: "agent",
      provider: ["provider"],
      system: ["env", "skills"],
      user: "user",
      isCodex: false,
    })

    expect(system).toEqual(["agent", "env\nskills\nuser"])
  })

  test("returns prefix only when rest is empty", () => {
    const system = LLM.prompts({
      prompt: "agent",
      provider: ["provider"],
      system: [],
      isCodex: false,
    })

    expect(system).toEqual(["agent"])
  })

  test("falls back to provider prompt when agent prompt is missing", () => {
    const system = LLM.prompts({
      provider: ["provider"],
      system: ["env"],
      isCodex: false,
    })

    expect(system).toEqual(["provider", "env"])
  })

  test("uses only rest for codex when no agent prompt exists", () => {
    const system = LLM.prompts({
      provider: ["provider"],
      system: ["env"],
      isCodex: true,
    })

    expect(system).toEqual(["env"])
  })
})
