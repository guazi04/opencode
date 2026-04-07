import path from "path"
import { describe, expect, test } from "bun:test"
import { NamedError } from "@opencode-ai/util/error"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { InstructionPrompt } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageID, PartID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { Token } from "../../src/util/token"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function chat(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(payload))
      ctrl.close()
    },
  })
}

function hanging(ready: () => void) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const first =
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    })}` + "\n\n"
  const rest =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: "late" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(first))
      ready()
      timer = setTimeout(() => {
        ctrl.enqueue(encoder.encode(rest))
        ctrl.close()
      }, 10000)
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })
}

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt regression", () => {
  test("does not loop empty assistant turns for a simple reply", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        calls++
        return new Response(chat("packages/opencode/src/session/processor.ts"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Prompt regression" })
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Where is SessionProcessor?" }],
          })

          expect(result.info.role).toBe("assistant")
          expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

          const msgs = await Session.messages({ sessionID: session.id })
          expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
          expect(calls).toBe(1)
        },
      })
    } finally {
      server.stop(true)
    }
  })

  test("records aborted errors when prompt is cancelled mid-stream", async () => {
    const ready = defer<void>()
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        return new Response(
          hanging(() => ready.resolve()),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        )
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Prompt cancel regression" })
          const run = SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Cancel me" }],
          })

          await ready.promise
          await SessionPrompt.cancel(session.id)

          const result = await Promise.race([
            run,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timed out waiting for cancel")), 1000),
            ),
          ])

          expect(result.info.role).toBe("assistant")
          if (result.info.role === "assistant") {
            expect(result.info.error?.name).toBe("MessageAbortedError")
          }

          const msgs = await Session.messages({ sessionID: session.id })
          const last = msgs.findLast((msg) => msg.info.role === "assistant")
          expect(last?.info.role).toBe("assistant")
          if (last?.info.role === "assistant") {
            expect(last.info.error?.name).toBe("MessageAbortedError")
          }
        },
      })
    } finally {
      server.stop(true)
    }
  })
})

describe("session.prompt context command", () => {
  test("runs locally from the last assistant usage", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user: MessageV2.User = {
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() - 10 },
          agent: "build",
          model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          parentID: user.id,
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            total: 1600,
            input: 500,
            output: 600,
            reasoning: 200,
            cache: { read: 200, write: 100 },
          },
          modelID: ModelID.make("gpt-5.2"),
          providerID: ProviderID.make("openai"),
          time: { created: Date.now() - 5, completed: Date.now() - 1 },
          sessionID: session.id,
          finish: "stop",
        }
        await Session.updateMessage(assistant)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "hi",
        })

        const result = await SessionPrompt.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const text = result.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("Total usage:")
        expect(text).toContain("Cache: 200 read / 100 write / 500 new input")
        expect(text).toContain("Estimated breakdown:")
        expect(text).toContain("Skills:")
        expect(text).toContain("MCP tools:")
        expect(text).toContain("Agents:")
        const part = result.parts.find((part): part is MessageV2.TextPart => part.type === "text")
        expect(part).toBeDefined()
        expect(part?.metadata?.command).toBe("context")
        expect(part?.metadata?.local).toBe(true)
        expect(part?.metadata?.data).toMatchObject({
          model: "openai/gpt-5.2",
          agent: "build",
          used: 1600,
          limit: expect.any(Number),
          reserved: expect.any(Number),
          free: expect.any(Number),
          categories: {
            tools: expect.any(Number),
            system: expect.any(Number),
            skills: expect.any(Number),
            messages: expect.any(Number),
          },
          cache: {
            read: 200,
            write: 100,
            input: 500,
          },
          skills: expect.any(Array),
          mcpTools: expect.any(Array),
          agents: expect.any(Array),
          hasAssistant: true,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        expect(msgs.filter((msg) => msg.info.role === "user")).toHaveLength(1)
        expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(2)

        await Session.remove(session.id)
      },
    })
  })

  test("works before any assistant usage exists", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        expect(result.info.role).toBe("assistant")
        const text = result.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        expect(text).toContain("Total usage: 0")
        expect(text).toContain("No assistant usage has been recorded yet")
        const part = result.parts.find((part): part is MessageV2.TextPart => part.type === "text")
        expect(part?.metadata?.data).toMatchObject({
          used: 0,
          hasAssistant: false,
        })

        await Session.remove(session.id)
      },
    })
  })

  test("keeps last real usage across repeated context calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user: MessageV2.User = {
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() - 10 },
          agent: "build",
          model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })
        await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: user.id,
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            total: 1600,
            input: 500,
            output: 600,
            reasoning: 200,
            cache: { read: 200, write: 100 },
          },
          modelID: ModelID.make("gpt-5.2"),
          providerID: ProviderID.make("openai"),
          time: { created: Date.now() - 5, completed: Date.now() - 1 },
          sessionID: session.id,
          finish: "stop",
        })

        const first = await SessionPrompt.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
        })
        const second = await SessionPrompt.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
        })

        const one = first.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        const two = second.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(one).toContain("Total usage: 1.6k")
        expect(two).toContain("Total usage: 1.6k")
        expect(two).toContain("Cache: 200 read / 100 write / 500 new input")

        await Session.remove(session.id)
      },
    })
  })

  test("matches llm prompt composition for stored system text", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "local instructions\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const model = {
          providerID: ProviderID.make("openai"),
          api: { id: "gpt-5.2" },
        } as Parameters<typeof SystemPrompt.provider>[0]
        const instructions = await InstructionPrompt.system()
        const sys = instructions[0]
        expect(sys).toBeTruthy()

        const user: MessageV2.User = {
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          time: { created: Date.now() - 10 },
          agent: "build",
          model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
          system: sys,
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })
        const result = await SessionPrompt.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
        })
        const part = result.parts.find((item): item is MessageV2.TextPart => item.type === "text")
        const prompt = LLM.prompts({
          provider: SystemPrompt.provider(model),
          system: [...(await SystemPrompt.environment(model)), ...instructions],
          user: sys,
          isCodex: false,
        })
        const exp = prompt.reduce((sum, item) => sum + Token.estimate(item), 0)

        expect(part?.metadata?.data).toMatchObject({
          categories: {
            system: exp,
          },
        })

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.agent-resolution", () => {
  test("unknown agent throws typed error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const err = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(err).toBeDefined()
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      },
    })
  }, 30000)

  test("unknown agent error includes available agent names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const err = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      },
    })
  }, 30000)

  test("unknown command throws typed error with available names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const err = await SessionPrompt.command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(err).toBeDefined()
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      },
    })
  }, 30000)
})
