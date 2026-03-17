import { describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const model = {
  id: ModelID.make("gpt-4"),
  providerID: ProviderID.make("openai"),
  name: "Mock",
  limit: {
    context: 128000,
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
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/openai" },
  options: {},
}

mock.module("../../src/session/processor", () => ({
  SessionProcessor: {
    create: (input: { assistantMessage: Record<string, unknown> }) => ({
      message: input.assistantMessage,
      process: async () => "continue",
    }),
  },
}))

mock.module("../../src/provider/provider", () => ({
  Provider: {
    getModel: async () => model,
  },
}))

mock.module("@/agent/agent", () => ({
  Agent: {
    get: async () => ({
      name: "compaction",
      mode: "subagent",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      model: {
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-4"),
      },
    }),
  },
}))

mock.module("@/plugin", () => ({
  Plugin: {
    trigger: async (_name: string, _input: unknown, output: unknown) => output,
  },
}))

mock.module("@/config/config", () => ({
  Config: {
    get: async () => ({
      compaction: {
        reclaim: false,
      },
    }),
  },
}))

describe("session.compaction restore", () => {
  test("restores user agent configuration on synthetic continue after compaction", async () => {
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
  })
})
