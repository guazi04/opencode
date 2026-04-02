import { Cause, Effect, Layer, ServiceMap } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Log } from "@/util/log"
import { Session } from "."
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Question } from "@/question"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const STREAM_IDLE_TIMEOUT_MS = 600_000
  const NEAR_MAX = 0.95
  const PATH_RE = /"filePath"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/
  const THROTTLE_MS = 500
  const THROTTLE_BYTES = 16384
  const log = Log.create({ service: "session.processor" })

  export type Result = "compact" | "stop" | "continue"

  export type Event = LLM.Event

  export interface Handle {
    readonly message: MessageV2.Assistant
    readonly partFromToolCall: (toolCallID: string) => MessageV2.ToolPart | undefined
    readonly nearMax: boolean
    readonly abort: () => Effect.Effect<void>
    readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  }

  type Input = {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
  }

  export interface Interface {
    readonly create: (input: Input) => Effect.Effect<Handle>
  }

  interface ProcessorContext extends Input {
    toolcalls: Record<string, MessageV2.ToolPart>
    shouldBreak: boolean
    snapshot: string | undefined
    blocked: boolean
    needsCompaction: boolean
    currentText: MessageV2.TextPart | undefined
    reasoningMap: Record<string, MessageV2.ReasoningPart>
    active: Set<string>
    deltas: Record<string, { text: string; bytes: number; path: string | undefined; last: number }>
    idle: boolean
    nearMax: boolean
  }

  type StreamEvent = Event

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionProcessor") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Session.Service
    | Config.Service
    | Bus.Service
    | Snapshot.Service
    | Agent.Service
    | LLM.Service
    | Permission.Service
    | Plugin.Service
    | SessionStatus.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const session = yield* Session.Service
      const config = yield* Config.Service
      const bus = yield* Bus.Service
      const snapshot = yield* Snapshot.Service
      const agents = yield* Agent.Service
      const llm = yield* LLM.Service
      const permission = yield* Permission.Service
      const plugin = yield* Plugin.Service
      const status = yield* SessionStatus.Service

      const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
        let aborted = false
        const ctx: ProcessorContext = {
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          toolcalls: {},
          shouldBreak: false,
          snapshot: undefined,
          blocked: false,
          needsCompaction: false,
          currentText: undefined,
          reasoningMap: {},
          active: new Set<string>(),
          deltas: {},
          idle: false,
          nearMax: false,
        }

        const parse = (e: unknown) => {
          if (ctx.idle && !aborted) {
            ctx.idle = false
            return new MessageV2.APIError({
              message: "LLM stream idle timeout, no data received",
              isRetryable: true,
              metadata: { source: "session.processor" },
            }).toObject()
          }
          return MessageV2.fromError(e, {
            providerID: input.model.providerID,
            aborted,
          })
        }

        const handleEvent = Effect.fn("SessionProcessor.handleEvent")(function* (value: StreamEvent) {
          switch (value.type) {
            case "start":
              yield* status.set(ctx.sessionID, { type: "busy" })
              return

            case "reasoning-start":
              if (value.id in ctx.reasoningMap) return
              ctx.reasoningMap[value.id] = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.reasoningMap[value.id])
              return

            case "reasoning-delta":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text += value.text
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.reasoningMap[value.id].sessionID,
                messageID: ctx.reasoningMap[value.id].messageID,
                partID: ctx.reasoningMap[value.id].id,
                field: "text",
                delta: value.text,
              })
              return

            case "reasoning-end":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text.trimEnd()
              ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePart(ctx.reasoningMap[value.id])
              delete ctx.reasoningMap[value.id]
              return

            case "tool-input-start":
              if (ctx.assistantMessage.summary) {
                throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
              }
              ctx.toolcalls[value.id] = (yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.id ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.toolName,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
              })) as MessageV2.ToolPart
              return

            case "tool-input-delta": {
              const match = ctx.toolcalls[value.id]
              if (!match || match.state.status !== "pending") return
              const acc =
                ctx.deltas[value.id] ?? (ctx.deltas[value.id] = { text: "", bytes: 0, path: undefined, last: 0 })
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
                ctx.toolcalls[value.id] = (yield* session.updatePart({
                  ...match,
                  state: {
                    status: "pending",
                    input: acc.path ? { ...match.state.input, filePath: acc.path } : match.state.input,
                    raw: match.state.raw,
                    received: acc.bytes,
                  },
                })) as MessageV2.ToolPart
              }
              return
            }

            case "tool-input-end":
              delete ctx.deltas[value.id]
              return

            case "tool-call": {
              if (ctx.assistantMessage.summary) {
                throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
              }
              const match = ctx.toolcalls[value.toolCallId]
              if (!match) return
              ctx.toolcalls[value.toolCallId] = (yield* session.updatePart({
                ...match,
                tool: value.toolName,
                state: { status: "running", input: value.input, time: { start: Date.now() } },
                metadata: value.providerMetadata,
              })) as MessageV2.ToolPart
              ctx.active.add(value.toolCallId)
              delete ctx.deltas[value.toolCallId]

              const parts = yield* Effect.promise(() => MessageV2.parts(ctx.assistantMessage.id))
              const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

              if (
                recentParts.length !== DOOM_LOOP_THRESHOLD ||
                !recentParts.every(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === value.toolName &&
                    part.state.status !== "pending" &&
                    JSON.stringify(part.state.input) === JSON.stringify(value.input),
                )
              ) {
                return
              }

              const agent = yield* agents.get(ctx.assistantMessage.agent)
              yield* permission.ask({
                permission: "doom_loop",
                patterns: [value.toolName],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.toolName, input: value.input },
                always: [value.toolName],
                ruleset: agent.permission,
              })
              return
            }

            case "tool-result": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") return
              yield* session.updatePart({
                ...match,
                state: {
                  status: "completed",
                  input: value.input ?? match.state.input,
                  output: value.output.output,
                  metadata: value.output.metadata,
                  title: value.output.title,
                  time: { start: match.state.time.start, end: Date.now() },
                  attachments: value.output.attachments,
                },
              })
              delete ctx.toolcalls[value.toolCallId]
              ctx.active.delete(value.toolCallId)
              return
            }

            case "tool-error": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") return
              yield* session.updatePart({
                ...match,
                state: {
                  status: "error",
                  input: value.input ?? match.state.input,
                  error: value.error instanceof Error ? value.error.message : String(value.error),
                  time: { start: match.state.time.start, end: Date.now() },
                },
              })
              if (value.error instanceof Permission.RejectedError || value.error instanceof Question.RejectedError) {
                ctx.blocked = ctx.shouldBreak
              }
              delete ctx.toolcalls[value.toolCallId]
              ctx.active.delete(value.toolCallId)
              return
            }

            case "error":
              throw value.error

            case "start-step":
              ctx.snapshot = yield* snapshot.track()
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                snapshot: ctx.snapshot,
                type: "step-start",
              })
              return

            case "finish-step": {
              const usage = Session.getUsage({
                model: ctx.model,
                usage: value.usage,
                metadata: value.providerMetadata,
              })
              const output = value.usage?.outputTokens ?? 0
              const max = ProviderTransform.maxOutputTokens(ctx.model)
              const near = value.finishReason === "tool-calls" && output >= max * NEAR_MAX
              ctx.nearMax = near
              const reason = near ? "length" : value.finishReason
              log.info("finish-step", {
                finishReason: reason,
                originalReason: value.finishReason,
                near,
                inputTokens: value.usage?.inputTokens,
                outputTokens: output,
                maxOutputTokens: max,
              })
              ctx.assistantMessage.finish = reason
              ctx.assistantMessage.cost += usage.cost
              ctx.assistantMessage.tokens = usage.tokens
              yield* session.updatePart({
                id: PartID.ascending(),
                reason,
                snapshot: yield* snapshot.track(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
              })
              yield* session.updateMessage(ctx.assistantMessage)
              if (ctx.snapshot) {
                const patch = yield* snapshot.patch(ctx.snapshot)
                if (patch.files.length) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "patch",
                    hash: patch.hash,
                    files: patch.files,
                  })
                }
                ctx.snapshot = undefined
              }
              SessionSummary.summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              if (
                !ctx.assistantMessage.summary &&
                isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
              ) {
                ctx.needsCompaction = true
              }
              return
            }

            case "text-start":
              ctx.currentText = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.currentText)
              return

            case "text-delta":
              if (!ctx.currentText) return
              ctx.currentText.text += value.text
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta: value.text,
              })
              return

            case "text-end":
              if (!ctx.currentText) return
              ctx.currentText.text = ctx.currentText.text.trimEnd()
              ctx.currentText.text = (yield* plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text
              ctx.currentText.time = { start: Date.now(), end: Date.now() }
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePart(ctx.currentText)
              ctx.currentText = undefined
              return

            case "finish":
              return

            default:
              log.info("unhandled", { ...value })
              return
          }
        })

        const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
          if (ctx.snapshot) {
            const patch = yield* snapshot.patch(ctx.snapshot)
            if (patch.files.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            ctx.snapshot = undefined
          }

          if (ctx.currentText) {
            const end = Date.now()
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
          }

          for (const part of Object.values(ctx.reasoningMap)) {
            const end = Date.now()
            yield* session.updatePart({
              ...part,
              time: { start: part.time.start ?? end, end },
            })
          }
          ctx.reasoningMap = {}

          const parts = yield* Effect.promise(() => MessageV2.parts(ctx.assistantMessage.id))
          for (const part of parts) {
            if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution aborted",
                time: { start: Date.now(), end: Date.now() },
              },
            })
          }
          ctx.assistantMessage.time.completed = Date.now()
          yield* session.updateMessage(ctx.assistantMessage)
        })

        const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
          log.error("process", { error: e, stack: e instanceof Error ? e.stack : undefined })
          const error = parse(e)
          if (MessageV2.ContextOverflowError.isInstance(error)) {
            ctx.needsCompaction = true
            yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            return
          }
          ctx.assistantMessage.error = error
          yield* bus.publish(Session.Event.Error, {
            sessionID: ctx.assistantMessage.sessionID,
            error: ctx.assistantMessage.error,
          })
          yield* status.set(ctx.sessionID, { type: "idle" })
        })

        const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
          return yield* Effect.gen(function* () {
            log.info("process")
            ctx.needsCompaction = false
            ctx.nearMax = false
            aborted = false
            ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
            const sig = streamInput.abort

            yield* Effect.gen(function* () {
              ctx.currentText = undefined
              ctx.reasoningMap = {}
              ctx.idle = false
              const ctl = new AbortController()
              const relay = () => {
                aborted = true
                ctl.abort(sig?.reason)
              }
              if (sig) {
                sig.addEventListener("abort", relay, { once: true })
                if (sig.aborted) relay()
              }

              let timerId: ReturnType<typeof setTimeout> | undefined
              const arm = (ms = STREAM_IDLE_TIMEOUT_MS) => {
                if (timerId) clearTimeout(timerId)
                timerId = setTimeout(() => {
                  if (sig?.aborted || ctl.signal.aborted) return
                  ctx.idle = true
                  log.warn(`LLM stream idle timeout after ${Math.round(ms / 1000)}s`, {
                    sessionID: ctx.sessionID,
                    providerID: ctx.model.providerID,
                    modelID: ctx.model.id,
                  })
                  ctl.abort(new DOMException("LLM stream idle timeout", "TimeoutError"))
                }, ms)
              }
              const clear = () => {
                if (timerId) clearTimeout(timerId)
                if (sig) sig.removeEventListener("abort", relay)
              }

              try {
                const stream = llm.stream({ ...streamInput, abort: ctl.signal })
                arm()
                yield* stream.pipe(
                  Stream.tap((event) =>
                    Effect.gen(function* () {
                      if (timerId) {
                        clearTimeout(timerId)
                        timerId = undefined
                      }
                      sig?.throwIfAborted()
                      yield* handleEvent(event)
                      if (!ctx.needsCompaction && !ctl.signal.aborted) {
                        if (ctx.active.size === 0) arm()
                        else arm(STREAM_IDLE_TIMEOUT_MS * 2)
                      }
                    }),
                  ),
                  Stream.takeUntil(() => ctx.needsCompaction),
                  Stream.runDrain,
                )
                if (ctx.idle) throw ctl.signal.reason
              } finally {
                clear()
              }
            }).pipe(
              Effect.onInterrupt(() => Effect.sync(() => void (aborted = true))),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.fail(Cause.squash(cause)),
              ),
              Effect.retry(
                SessionRetry.policy({
                  parse,
                  set: (info) =>
                    status.set(ctx.sessionID, {
                      type: "retry",
                      attempt: info.attempt,
                      message: info.message,
                      next: info.next,
                    }),
                }),
              ),
              Effect.catch(halt),
              Effect.ensuring(cleanup()),
            )

            if (aborted && !ctx.assistantMessage.error) {
              yield* abort()
            }
            if (ctx.needsCompaction) return "compact"
            if (ctx.blocked || ctx.assistantMessage.error || aborted) return "stop"
            return "continue"
          }).pipe(Effect.onInterrupt(() => abort().pipe(Effect.asVoid)))
        })

        const abort = Effect.fn("SessionProcessor.abort")(() =>
          Effect.gen(function* () {
            if (!ctx.assistantMessage.error) {
              yield* halt(new DOMException("Aborted", "AbortError"))
            }
            if (!ctx.assistantMessage.time.completed) {
              yield* cleanup()
              return
            }
            yield* session.updateMessage(ctx.assistantMessage)
          }),
        )

        return {
          get message() {
            return ctx.assistantMessage
          },
          get nearMax() {
            return ctx.nearMax
          },
          partFromToolCall(toolCallID: string) {
            return ctx.toolcalls[toolCallID]
          },
          abort,
          process,
        } satisfies Handle
      })

      return Service.of({ create })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(Snapshot.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(LLM.defaultLayer),
        Layer.provide(Permission.layer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(SessionStatus.layer.pipe(Layer.provide(Bus.layer))),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )
}
