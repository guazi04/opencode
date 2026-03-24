import { describe, expect, mock, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const model: Provider.Model = {
  id: ModelID.make("gpt-4"),
  providerID: ProviderID.make("openai"),
  name: "Mock",
  api: {
    id: "gpt-4",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  limit: {
    context: 128000,
    input: 124000,
    output: 4096,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  status: "active",
  headers: {},
  release_date: "2026-03-23",
  options: {},
}

describe("session.compaction restore", () => {
  test("restores user agent configuration on synthetic continue after compaction", async () => {
    spyOn(SessionProcessor, "create").mockImplementation((input: Parameters<typeof SessionProcessor.create>[0]) => ({
      message: input.assistantMessage,
      nearMax: false,
      partFromToolCall: (callID: string) => ({
        id: PartID.ascending(),
        messageID: input.assistantMessage.id,
        sessionID: input.assistantMessage.sessionID,
        type: "tool",
        callID,
        tool: "mock",
        state: {
          status: "pending",
          input: {},
          raw: "",
        },
      }),
      process: async () => "continue",
    }))
    spyOn(Provider, "getModel").mockImplementation(async () => model)
    spyOn(Agent, "get").mockImplementation(async () => ({
      name: "compaction",
      mode: "subagent",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      model: {
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-4"),
      },
    }))
    try {
      const { SessionCompaction } = await import("../../src/session/compaction")
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const msg = await Session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "build",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            format: { type: "text" },
            tools: { bash: true, read: false },
            system: "Main session system prompt",
            variant: "high",
          })
          if (msg.role !== "user") {
            throw new Error("expected user message")
          }
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: session.id,
            type: "text",
            text: "Please continue",
          })
          const list = await Session.messages({ sessionID: session.id })
          const result = await SessionCompaction.process({
            parentID: msg.id,
            messages: list,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: true,
          })
          expect(result).toBe("continue")

          const msgs = await Session.messages({ sessionID: session.id })
          const next = msgs.findLast((x) => x.info.role === "user" && x.info.id > msg.id)
          if (!next) {
            throw new Error("expected synthetic continue user message")
          }
          if (next.info.role !== "user") {
            throw new Error("expected user message")
          }
          expect(next.info.agent).toBe(msg.agent)
          expect(next.info.model).toEqual(msg.model)
          expect(next.info.format).toEqual(msg.format)
          expect(next.info.tools).toEqual(msg.tools)
          expect(next.info.system).toBe(msg.system)
          expect(next.info.variant).toBe(msg.variant)

          const text = next.parts.find((x) => x.type === "text")
          expect(text?.type).toBe("text")
          if (!text || text.type !== "text") {
            throw new Error("expected synthetic continue part")
          }
          expect(text.synthetic).toBe(true)
        },
      })
    } finally {
      mock.restore()
    }
  })
})
