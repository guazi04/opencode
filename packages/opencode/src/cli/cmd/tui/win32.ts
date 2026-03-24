const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

type K32 = {
  symbols: {
    GetStdHandle: (id: number) => number
    GetConsoleMode: (handle: number, mode: number) => number
    SetConsoleMode: (handle: number, mode: number) => number
    FlushConsoleInputBuffer: (handle: number) => number
  }
}

type BunFfi = {
  dlopen: (name: string, symbols: Record<string, { args: string[]; returns: string }>) => K32
  ptr: (input: ArrayBufferView) => number
}

const symbols = {
  GetStdHandle: { args: ["i32"], returns: "ptr" },
  GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
  SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
  FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
}

const kernel = (bun: BunFfi) => bun.dlopen("kernel32.dll", symbols)

let k32: K32 | undefined
let p: BunFfi["ptr"] | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    const bun = (globalThis as { Bun?: Partial<BunFfi> }).Bun
    if (!bun || typeof bun.dlopen !== "function" || typeof bun.ptr !== "function") return false
    k32 ??= kernel(bun as BunFfi)
    p = bun.ptr
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (!p) return
  const ptr = p

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (!p) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (!p) return
  const ptr = p
  if (unhook) return unhook

  const stdin = process.stdin
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
  const initial = buf[0]!

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: typeof stdin.setRawMode | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    k32!.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
