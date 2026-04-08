import { describe, expect, mock, spyOn, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"

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
    const provider = ProviderTest.fake({ model })
    const layer = Layer.succeed(
      SessionProcessor.Service,
      SessionProcessor.Service.of({
        create: Effect.fn("TestSessionProcessor.create")((input) =>
          Effect.succeed({
            message: input.assistantMessage,
            system: undefined,
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
            abort: Effect.fn("TestSessionProcessor.abort")(() => Effect.void),
            process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed("continue")),
          }),
        ),
      }),
    )
    const rt = ManagedRuntime.make(
      SessionCompaction.layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(layer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(provider.layer),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    )
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
            system_context: "env\nagent\ninstruction",
            system_segments: ["env", "agent", "instruction"],
            tool_context: [
              {
                id: "bash",
                description: "Run shell commands",
                schema: "object • props(command:string)",
              },
            ],
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
          await SessionCompaction.create({
            sessionID: session.id,
            agent: msg.agent,
            model: msg.model,
            format: msg.format,
            tools: msg.tools,
            system: msg.system,
            system_context: msg.system_context,
            system_segments: msg.system_segments,
            tool_context: msg.tool_context,
            variant: msg.variant,
            auto: true,
          })
          const list = await Session.messages({ sessionID: session.id })
          const marker = list.findLast(
            (x) => x.info.role === "user" && x.parts.some((part) => part.type === "compaction"),
          )
          if (!marker) {
            throw new Error("expected compaction marker user message")
          }
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: marker.info.id,
                messages: list,
                sessionID: session.id,
                abort: new AbortController().signal,
                auto: true,
              }),
            ),
          )
          expect(result).toBe("continue")

          const msgs = await Session.messages({ sessionID: session.id })
          const next = msgs.findLast((x) => x.info.role === "user" && x.info.id > marker.info.id)
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
          expect(next.info.system_context).toBe(msg.system_context)
          expect(next.info.system_segments).toEqual(msg.system_segments)
          expect(next.info.tool_context).toEqual(msg.tool_context)
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
      await rt.dispose()
      mock.restore()
    }
  })

  test("restores checkpointed agent configuration when overflow replay reuses older parts", async () => {
    const provider = ProviderTest.fake({ model })
    const layer = Layer.succeed(
      SessionProcessor.Service,
      SessionProcessor.Service.of({
        create: Effect.fn("TestSessionProcessor.create")((input) =>
          Effect.succeed({
            message: input.assistantMessage,
            system: undefined,
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
            abort: Effect.fn("TestSessionProcessor.abort")(() => Effect.void),
            process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed("continue")),
          }),
        ),
      }),
    )
    const rt = ManagedRuntime.make(
      SessionCompaction.layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(layer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(provider.layer),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    )
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
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const seed = await Session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "seed",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
          })
          if (seed.role !== "user") {
            throw new Error("expected seed user message")
          }
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: seed.id,
            sessionID: session.id,
            type: "text",
            text: "Seed",
          })
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
            tools: { read: true },
            system: "Old session system prompt",
            system_context: "old-env\nold-agent",
            system_segments: ["old-env", "old-agent"],
            tool_context: [
              {
                id: "read",
                description: "Read files",
                schema: "object • props(filePath:string)",
              },
            ],
            variant: "low",
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
          await SessionCompaction.create({
            sessionID: session.id,
            agent: "plan",
            model: msg.model,
            format: { type: "text" },
            tools: { bash: true, read: true },
            system: "Checkpointed system prompt",
            system_context: "new-env\nnew-agent\nnew-instruction",
            system_segments: ["new-env", "new-agent", "new-instruction"],
            tool_context: [
              {
                id: "bash",
                description: "Run shell commands",
                schema: "object • props(command:string)",
              },
            ],
            variant: "high",
            auto: true,
            overflow: true,
          })
          const list = await Session.messages({ sessionID: session.id })
          const marker = list.findLast(
            (x) => x.info.role === "user" && x.parts.some((part) => part.type === "compaction"),
          )
          if (!marker) {
            throw new Error("expected compaction marker user message")
          }
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: marker.info.id,
                messages: list,
                sessionID: session.id,
                abort: new AbortController().signal,
                auto: true,
                overflow: true,
              }),
            ),
          )
          expect(result).toBe("continue")

          const msgs = await Session.messages({ sessionID: session.id })
          const next = msgs.findLast((x) => x.info.role === "user" && x.info.id > marker.info.id)
          if (!next) {
            throw new Error("expected replayed user message")
          }
          if (next.info.role !== "user") {
            throw new Error("expected user message")
          }
          expect(next.info.agent).toBe("plan")
          expect(next.info.model).toEqual(msg.model)
          expect(next.info.format).toEqual({ type: "text" })
          expect(next.info.tools).toEqual({ bash: true, read: true })
          expect(next.info.system).toBe("Checkpointed system prompt")
          expect(next.info.system_context).toBe("new-env\nnew-agent\nnew-instruction")
          expect(next.info.system_segments).toEqual(["new-env", "new-agent", "new-instruction"])
          expect(next.info.tool_context).toEqual([
            {
              id: "bash",
              description: "Run shell commands",
              schema: "object • props(command:string)",
            },
          ])
          expect(next.info.variant).toBe("high")

          const text = next.parts.find((x) => x.type === "text")
          expect(text?.type).toBe("text")
          if (!text || text.type !== "text") {
            throw new Error("expected replayed text part")
          }
          expect(text.text).toBe("Please continue")
        },
      })
    } finally {
      await rt.dispose()
      mock.restore()
    }
  })
})
