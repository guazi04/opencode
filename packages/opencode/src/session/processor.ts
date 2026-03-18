import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission"
import { Question } from "@/question"
import { PartID } from "./schema"
import type { SessionID, MessageID } from "./schema"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const STREAM_IDLE_TIMEOUT_MS = 600_000
  const STREAM_IDLE_TIMEOUT_S = STREAM_IDLE_TIMEOUT_MS / 1000
  const NEAR_MAX = 0.95
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    const deltas: Record<string, { text: string; bytes: number; path: string | undefined; last: number }> = {}
    const PATH_RE = /"filePath"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/
    const THROTTLE_MS = 500
    const THROTTLE_BYTES = 16384

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          let idle = false
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const ctl = new AbortController()
            const relay = () => ctl.abort(input.abort.reason)
            input.abort.addEventListener("abort", relay, { once: true })
            if (input.abort.aborted) relay()
            const active = new Set<string>()

            let id: ReturnType<typeof setTimeout> | undefined
            const arm = (ms = STREAM_IDLE_TIMEOUT_MS) => {
              if (id) clearTimeout(id)
              id = setTimeout(() => {
                if (input.abort.aborted || ctl.signal.aborted) return
                idle = true
                const sec = Math.round(ms / 1000)
                log.warn(`LLM stream idle timeout after ${sec}s, no data received`, {
                  sessionID: input.sessionID,
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                })
                ctl.abort(new DOMException("LLM stream idle timeout", "TimeoutError"))
              }, ms)
            }

            const clear = () => {
              if (id) clearTimeout(id)
              input.abort.removeEventListener("abort", relay)
            }

            try {
              const stream = await LLM.stream({
                ...streamInput,
                abort: ctl.signal,
              })
              arm()
              for await (const value of stream.fullStream) {
                if (id) {
                  clearTimeout(id)
                  id = undefined
                }
                try {
                  input.abort.throwIfAborted()
                  switch (value.type) {
                    case "start":
                      SessionStatus.set(input.sessionID, { type: "busy" })
                      break

                    case "reasoning-start":
                      if (value.id in reasoningMap) {
                        continue
                      }
                      const reasoningPart = {
                        id: PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.assistantMessage.sessionID,
                        type: "reasoning" as const,
                        text: "",
                        time: {
                          start: Date.now(),
                        },
                        metadata: value.providerMetadata,
                      }
                      reasoningMap[value.id] = reasoningPart
                      await Session.updatePart(reasoningPart)
                      break

                    case "reasoning-delta":
                      if (value.id in reasoningMap) {
                        const part = reasoningMap[value.id]
                        part.text += value.text
                        if (value.providerMetadata) part.metadata = value.providerMetadata
                        await Session.updatePartDelta({
                          sessionID: part.sessionID,
                          messageID: part.messageID,
                          partID: part.id,
                          field: "text",
                          delta: value.text,
                        })
                      }
                      break

                    case "reasoning-end":
                      if (value.id in reasoningMap) {
                        const part = reasoningMap[value.id]
                        part.text = part.text.trimEnd()

                        part.time = {
                          ...part.time,
                          end: Date.now(),
                        }
                        if (value.providerMetadata) part.metadata = value.providerMetadata
                        await Session.updatePart(part)
                        delete reasoningMap[value.id]
                      }
                      break

                    case "tool-input-start":
                      const part = await Session.updatePart({
                        id: toolcalls[value.id]?.id ?? PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.assistantMessage.sessionID,
                        type: "tool",
                        tool: value.toolName,
                        callID: value.id,
                        state: {
                          status: "pending",
                          input: {},
                          raw: "",
                        },
                      })
                      toolcalls[value.id] = part as MessageV2.ToolPart
                      break

                    case "tool-input-delta": {
                      const match = toolcalls[value.id]
                      if (!match || match.state.status !== "pending") break
                      const acc =
                        deltas[value.id] ?? (deltas[value.id] = { text: "", bytes: 0, path: undefined, last: 0 })
                      if (!acc.path && acc.text.length < 8192) acc.text += value.delta
                      acc.bytes += Buffer.byteLength(value.delta, "utf8")
                      if (!acc.path) {
                        const m = PATH_RE.exec(acc.text)
                        if (m) {
                          try {
                            acc.path = JSON.parse('"' + m[1] + '"')
                          } catch {
                            acc.path = m[1]
                          }
                          acc.text = ""
                        }
                      }
                      const now = Date.now()
                      const found = acc.path && !match.state.input.filePath
                      const elapsed = now - acc.last >= THROTTLE_MS
                      const grown = acc.bytes - (match.state.received ?? 0) >= THROTTLE_BYTES
                      if (found || elapsed || grown) {
                        acc.last = now
                        const updated = await Session.updatePart({
                          ...match,
                          state: {
                            status: "pending",
                            input: acc.path ? { ...match.state.input, filePath: acc.path } : match.state.input,
                            raw: match.state.raw,
                            received: acc.bytes,
                          },
                        })
                        toolcalls[value.id] = updated as MessageV2.ToolPart
                      }
                      break
                    }

                    case "tool-input-end":
                      delete deltas[value.id]
                      break

                    case "tool-call": {
                      log.info("tool-call", {
                        tool: value.toolName,
                        inputLength:
                          typeof value.input === "string"
                            ? value.input.length
                            : JSON.stringify(value.input ?? "").length,
                        toolCallId: value.toolCallId,
                      })
                      const match = toolcalls[value.toolCallId]
                      if (match) {
                        active.add(value.toolCallId)
                        const part = await Session.updatePart({
                          ...match,
                          tool: value.toolName,
                          state: {
                            status: "running",
                            input: value.input,
                            time: {
                              start: Date.now(),
                            },
                          },
                          metadata: value.providerMetadata,
                        })
                        toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                        const parts = await MessageV2.parts(input.assistantMessage.id)
                        const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                        if (
                          lastThree.length === DOOM_LOOP_THRESHOLD &&
                          lastThree.every(
                            (p) =>
                              p.type === "tool" &&
                              p.tool === value.toolName &&
                              p.state.status !== "pending" &&
                              JSON.stringify(p.state.input) === JSON.stringify(value.input),
                          )
                        ) {
                          const agent = await Agent.get(input.assistantMessage.agent)
                          await PermissionNext.ask({
                            permission: "doom_loop",
                            patterns: [value.toolName],
                            sessionID: input.assistantMessage.sessionID,
                            metadata: {
                              tool: value.toolName,
                              input: value.input,
                            },
                            always: [value.toolName],
                            ruleset: agent.permission,
                          })
                        }
                      }
                      delete deltas[value.toolCallId]
                      break
                    }
                    case "tool-result": {
                      const match = toolcalls[value.toolCallId]
                      log.info("tool-result", {
                        tool: match?.tool ?? "unknown",
                        status: "completed",
                        outputLength: typeof value.output.output === "string" ? value.output.output.length : 0,
                        toolCallId: value.toolCallId,
                      })
                      if (match && match.state.status === "running") {
                        await Session.updatePart({
                          ...match,
                          state: {
                            status: "completed",
                            input: value.input ?? match.state.input,
                            output: value.output.output,
                            metadata: value.output.metadata,
                            title: value.output.title,
                            time: {
                              start: match.state.time.start,
                              end: Date.now(),
                            },
                            attachments: value.output.attachments,
                          },
                        })

                        delete toolcalls[value.toolCallId]
                      }
                      active.delete(value.toolCallId)
                      break
                    }

                    case "tool-error": {
                      const match = toolcalls[value.toolCallId]
                      if (match && match.state.status === "running") {
                        await Session.updatePart({
                          ...match,
                          state: {
                            status: "error",
                            input: value.input ?? match.state.input,
                            error: (value.error as any).toString(),
                            time: {
                              start: match.state.time.start,
                              end: Date.now(),
                            },
                          },
                        })

                        if (
                          value.error instanceof PermissionNext.RejectedError ||
                          value.error instanceof Question.RejectedError
                        ) {
                          blocked = shouldBreak
                        }
                        delete toolcalls[value.toolCallId]
                      }
                      active.delete(value.toolCallId)
                      break
                    }
                    case "error":
                      throw value.error

                    case "start-step":
                      snapshot = await Snapshot.track()
                      await Session.updatePart({
                        id: PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        snapshot,
                        type: "step-start",
                      })
                      break

                    case "finish-step":
                      const output = value.usage?.outputTokens ?? 0
                      const max = ProviderTransform.maxOutputTokens(input.model)
                      const near = value.finishReason === "tool-calls" && output >= max * NEAR_MAX
                      const reason = near ? "length" : value.finishReason
                      log.warn("finish-step", {
                        finishReason: reason,
                        originalReason: value.finishReason,
                        near,
                        inputTokens: value.usage?.inputTokens,
                        outputTokens: output,
                        maxOutputTokens: max,
                        totalTokens: value.usage?.totalTokens,
                        hasPendingTools: Object.values(toolcalls).some(
                          (item) => item.state.status === "pending" || item.state.status === "running",
                        ),
                      })
                      const usage = Session.getUsage({
                        model: input.model,
                        usage: value.usage,
                        metadata: value.providerMetadata,
                      })
                      input.assistantMessage.finish = reason
                      input.assistantMessage.cost += usage.cost
                      input.assistantMessage.tokens = usage.tokens
                      await Session.updatePart({
                        id: PartID.ascending(),
                        reason,
                        snapshot: await Snapshot.track(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.assistantMessage.sessionID,
                        type: "step-finish",
                        tokens: usage.tokens,
                        cost: usage.cost,
                      })
                      await Session.updateMessage(input.assistantMessage)
                      if (snapshot) {
                        const patch = await Snapshot.patch(snapshot)
                        if (patch.files.length) {
                          await Session.updatePart({
                            id: PartID.ascending(),
                            messageID: input.assistantMessage.id,
                            sessionID: input.sessionID,
                            type: "patch",
                            hash: patch.hash,
                            files: patch.files,
                          })
                        }
                        snapshot = undefined
                      }
                      SessionSummary.summarize({
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.parentID,
                      })
                      if (
                        !input.assistantMessage.summary &&
                        (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                      ) {
                        needsCompaction = true
                      }
                      break

                    case "text-start":
                      currentText = {
                        id: PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.assistantMessage.sessionID,
                        type: "text",
                        text: "",
                        time: {
                          start: Date.now(),
                        },
                        metadata: value.providerMetadata,
                      }
                      await Session.updatePart(currentText)
                      break

                    case "text-delta":
                      if (currentText) {
                        currentText.text += value.text
                        if (value.providerMetadata) currentText.metadata = value.providerMetadata
                        await Session.updatePartDelta({
                          sessionID: currentText.sessionID,
                          messageID: currentText.messageID,
                          partID: currentText.id,
                          field: "text",
                          delta: value.text,
                        })
                      }
                      break

                    case "text-end":
                      if (currentText) {
                        currentText.text = currentText.text.trimEnd()
                        const textOutput = await Plugin.trigger(
                          "experimental.text.complete",
                          {
                            sessionID: input.sessionID,
                            messageID: input.assistantMessage.id,
                            partID: currentText.id,
                          },
                          { text: currentText.text },
                        )
                        currentText.text = textOutput.text
                        currentText.time = {
                          start: Date.now(),
                          end: Date.now(),
                        }
                        if (value.providerMetadata) currentText.metadata = value.providerMetadata
                        await Session.updatePart(currentText)
                      }
                      currentText = undefined
                      break

                    case "finish":
                      break

                    default:
                      log.info("unhandled", {
                        ...value,
                      })
                      continue
                  }
                  if (needsCompaction) break
                } finally {
                  if (!needsCompaction && !ctl.signal.aborted) {
                    if (active.size === 0) arm()
                    else arm(STREAM_IDLE_TIMEOUT_MS * 4)
                  }
                }
              }
              if (idle) throw ctl.signal.reason
            } finally {
              clear()
            }
          } catch (e) {
            log.error("process", {
              error: e,
              stack: JSON.stringify((e as Error | undefined)?.stack),
            })
            const error = input.abort.aborted
              ? MessageV2.fromError(e, { providerID: input.model.providerID })
              : idle
                ? new MessageV2.APIError({
                    message: `LLM stream idle timeout, no data received`,
                    isRetryable: true,
                    metadata: {
                      source: "session.processor",
                    },
                  }).toObject()
                : MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              needsCompaction = true
              Bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error,
              })
            } else {
              const retry = SessionRetry.retryable(error)
              if (retry !== undefined) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              SessionStatus.set(input.sessionID, { type: "idle" })
            }
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          // Check if ALL tools were aborted (likely due to output truncation)
          const parts = await MessageV2.parts(input.assistantMessage.id)
          const toolParts = parts.filter((p) => p.type === "tool")
          const aborted = toolParts.filter(
            (p) => p.state.status === "error" && p.state.error === "Tool execution aborted",
          ).length
          if (toolParts.length > 0 && aborted === toolParts.length) {
            input.assistantMessage.error = new MessageV2.AbortedError({
              message: "All tool calls were aborted (likely due to output truncation)",
            }).toObject()
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
