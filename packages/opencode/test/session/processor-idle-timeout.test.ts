import { describe, expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * Tests for the idle timeout pattern used in SessionProcessor.process().
 *
 * Instead of testing through the full processor (which has heavy Session/MessageV2/
 * Config deps), we replicate the exact timer+abort pattern and verify its behavior
 * with controllable async iterables and short timeout values.
 */

// Scaled-down timeout for fast tests. The real processor uses 75_000ms.
const IDLE_MS = 100

/**
 * Creates a controllable async iterable that emits values on demand.
 * Calling push() enqueues a value; calling done() signals completion.
 * The iterable is abort-aware: when the abort signal fires, pending
 * next() calls reject immediately (mimicking how real LLM streams
 * break out of for-await on abort).
 */
function iterable<T>(signal?: AbortSignal) {
  const queue: T[] = []
  let finished = false
  let notify: (() => void) | undefined
  let reject: ((err: unknown) => void) | undefined

  signal?.addEventListener(
    "abort",
    () => {
      reject?.(signal.reason)
      notify?.()
    },
    { once: true },
  )

  function push(v: T) {
    queue.push(v)
    notify?.()
  }

  function done() {
    finished = true
    notify?.()
  }

  const iter: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          while (true) {
            if (signal?.aborted) throw signal.reason
            if (queue.length) return { value: queue.shift()!, done: false }
            if (finished) return { value: undefined as any, done: true }
            await new Promise<void>((res, rej) => {
              notify = res
              reject = rej
            })
          }
        },
      }
    },
  }

  return { push, done, iter }
}

/**
 * Replicates the processor's idle-timeout + abort-relay pattern.
 * Returns collected values and whether idle fired.
 *
 * @param stream    controllable async iterable
 * @param parent    parent abort signal (simulates input.abort)
 * @param ms        idle timeout in ms
 * @param active    set of active tool call IDs — mirrors processor's `active` set
 */
async function run<T>(stream: AsyncIterable<T>, parent: AbortSignal, ms: number, active = new Set<string>()) {
  let idle = false
  const ctl = new AbortController()
  const relay = () => ctl.abort(parent.reason)
  parent.addEventListener("abort", relay, { once: true })
  if (parent.aborted) relay()

  let id: ReturnType<typeof setTimeout> | undefined
  const arm = (timeout = ms) => {
    if (id) clearTimeout(id)
    id = setTimeout(() => {
      if (parent.aborted || ctl.signal.aborted) return
      idle = true
      ctl.abort(new DOMException("LLM stream idle timeout", "TimeoutError"))
    }, timeout)
  }

  const clear = () => {
    if (id) clearTimeout(id)
    parent.removeEventListener("abort", relay)
  }

  const values: T[] = []

  try {
    arm()
    for await (const value of stream) {
      if (id) {
        clearTimeout(id)
        id = undefined
      }
      parent.throwIfAborted()
      values.push(value)
      if (!ctl.signal.aborted) {
        if (active.size === 0) arm()
        else arm(ms * 4)
      }
    }
    if (idle) throw ctl.signal.reason
  } finally {
    clear()
  }

  return { values, idle }
}

describe("processor.idle-timeout", () => {
  test("continuous chunks do not trigger timeout", async () => {
    const parent = new AbortController()
    const { push, done, iter } = iterable<string>(parent.signal)

    // Emit chunks faster than the idle timeout
    const emitter = (async () => {
      for (let i = 0; i < 5; i++) {
        push(`chunk-${i}`)
        await sleep(IDLE_MS / 3)
      }
      done()
    })()

    const result = await run(iter, parent.signal, IDLE_MS)
    await emitter
    expect(result.idle).toBe(false)
    expect(result.values).toEqual(["chunk-0", "chunk-1", "chunk-2", "chunk-3", "chunk-4"])
  })

  test("idle timeout fires after no data", async () => {
    const ctl = new AbortController()
    // Create iterable wired to the child ctl so it breaks on abort
    const child = new AbortController()
    const { iter } = iterable<string>(child.signal)

    // run() creates its own child AbortController internally; we need
    // the iterable to respond to THAT controller. Instead, we wire to
    // parent and rely on the relay pattern.
    // Simpler: just use a standalone implementation.
    let idle = false
    const relay = () => child.abort(ctl.signal.reason)
    ctl.signal.addEventListener("abort", relay, { once: true })

    let id: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number) => {
      if (id) clearTimeout(id)
      id = setTimeout(() => {
        if (ctl.signal.aborted || child.signal.aborted) return
        idle = true
        child.abort(new DOMException("LLM stream idle timeout", "TimeoutError"))
      }, ms)
    }

    arm(IDLE_MS)
    const err = await (async () => {
      try {
        for await (const _ of iter) {
          if (id) {
            clearTimeout(id)
            id = undefined
          }
          arm(IDLE_MS)
        }
        if (idle) throw child.signal.reason
      } finally {
        if (id) clearTimeout(id)
      }
    })().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe("TimeoutError")
    expect((err as DOMException).message).toContain("idle timeout")
  })

  test("tool execution uses longer timeout", async () => {
    const parent = new AbortController()
    const { push, done, iter } = iterable<string>(parent.signal)
    const active = new Set(["tool-1"])

    // Push one chunk to enter the loop, then stall.
    // With a tool active, timeout is ms * 4.
    // We wait > ms but < ms*4 — should NOT have timed out yet.
    const emitter = (async () => {
      push("first")
      // Wait more than the base timeout but less than 4x
      await sleep(IDLE_MS * 2)
      // Still alive — push second chunk
      push("second")
      await sleep(10)
      done()
    })()

    const result = await run(iter, parent.signal, IDLE_MS, active)
    await emitter

    expect(result.idle).toBe(false)
    expect(result.values).toEqual(["first", "second"])
  })

  test("tool execution timeout does fire at 4x", async () => {
    const parent = new AbortController()
    const active = new Set(["tool-1"])

    // We need the iterable to be abort-aware with the CHILD controller
    // that run() creates internally. Since we can't access it, we create
    // a custom iterable that reacts to any abort on the parent chain.
    const child = new AbortController()
    const { push, iter } = iterable<string>(child.signal)

    // Push one chunk then stall past 4x timeout.
    // We'll run the pattern inline to wire abort correctly.
    let idle = false
    let id: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number) => {
      if (id) clearTimeout(id)
      id = setTimeout(() => {
        if (parent.signal.aborted || child.signal.aborted) return
        idle = true
        child.abort(new DOMException("LLM stream idle timeout", "TimeoutError"))
      }, ms)
    }

    push("first")

    const err = await (async () => {
      try {
        arm(IDLE_MS)
        for await (const _ of iter) {
          if (id) {
            clearTimeout(id)
            id = undefined
          }
          // With active tools, arm at 4x
          arm(IDLE_MS * 4)
        }
        if (idle) throw child.signal.reason
      } finally {
        if (id) clearTimeout(id)
      }
    })().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe("TimeoutError")
  })

  test("parent abort relays to child", async () => {
    const parent = new AbortController()
    // Create a child that the iterable listens to
    const child = new AbortController()
    const { iter } = iterable<string>(child.signal)

    // Set up relay: parent -> child
    const relay = () => child.abort(parent.signal.reason)
    parent.signal.addEventListener("abort", relay, { once: true })

    const promise = (async () => {
      try {
        for await (const _ of iter) {
          parent.signal.throwIfAborted()
        }
      } finally {
        parent.signal.removeEventListener("abort", relay)
      }
    })()

    // Abort from parent side
    await sleep(20)
    parent.abort(new Error("user cancelled"))

    const err = await promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("user cancelled")
  })

  test("silent stream end with idle=true throws", async () => {
    // Simulate: the timeout fires, sets idle=true, aborts ctl — but
    // the for-await loop exits gracefully (the stream happens to end
    // at exactly the same moment). The `if (idle) throw ctl.signal.reason`
    // guard after the loop catches this.

    const ctl = new AbortController()
    let idle = false

    let id: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number) => {
      if (id) clearTimeout(id)
      id = setTimeout(() => {
        idle = true
        ctl.abort(new DOMException("LLM stream idle timeout", "TimeoutError"))
      }, ms)
    }
    const clear = () => {
      if (id) clearTimeout(id)
    }

    // Iterable that yields once then waits for the timeout to fire before ending
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let step = 0
        return {
          async next(): Promise<IteratorResult<string>> {
            if (step === 0) {
              step++
              return { value: "data", done: false }
            }
            // Wait until idle is set
            while (!idle) await sleep(10)
            // Return done — the stream ended gracefully (not via throw)
            return { value: undefined as any, done: true }
          },
        }
      },
    }

    const values: string[] = []
    let caught: unknown

    try {
      arm(IDLE_MS)
      for await (const v of stream) {
        if (id) {
          clearTimeout(id)
          id = undefined
        }
        values.push(v)
        if (!ctl.signal.aborted) arm(IDLE_MS)
      }
      if (idle) throw ctl.signal.reason
    } catch (e) {
      caught = e
    } finally {
      clear()
    }

    expect(values).toEqual(["data"])
    expect(idle).toBe(true)
    expect(caught).toBeInstanceOf(DOMException)
    expect((caught as DOMException).name).toBe("TimeoutError")
  })

  test("TOCTOU: addEventListener before aborted check relays pre-aborted signal", () => {
    // If the parent signal is already aborted BEFORE we attach the listener,
    // the relay pattern (addEventListener then check aborted) still fires.
    const parent = new AbortController()
    parent.abort(new Error("already dead"))

    const child = new AbortController()
    const relay = () => child.abort(parent.signal.reason)
    // This is the exact TOCTOU-safe pattern from the processor
    parent.signal.addEventListener("abort", relay, { once: true })
    if (parent.signal.aborted) relay()

    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBeInstanceOf(Error)
    expect((child.signal.reason as Error).message).toBe("already dead")
  })

  test("timeout does not fire if already aborted", async () => {
    // The setTimeout callback checks `if (parent.aborted || ctl.signal.aborted) return`
    // to avoid double-abort scenarios.
    const parent = new AbortController()
    const child = new AbortController()
    let idle = false

    const arm = (ms: number) => {
      setTimeout(() => {
        if (parent.signal.aborted || child.signal.aborted) return
        idle = true
        child.abort(new DOMException("timeout", "TimeoutError"))
      }, ms)
    }

    // Abort parent before timeout fires
    arm(IDLE_MS)
    parent.abort(new Error("cancelled"))
    await sleep(IDLE_MS + 50)

    // idle should remain false — the guard prevented it
    expect(idle).toBe(false)
    expect(child.signal.aborted).toBe(false)
  })
})
