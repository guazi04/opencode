#!/usr/bin/env bun

const file = "package.json"
const arg = process.argv[2]
const ok = ["patch", "minor", "sync", "current"].includes(arg)

if (!ok || process.argv.length !== 3) {
  console.error("usage: bun run script/version.ts <patch|minor|sync|current>")
  process.exit(1)
}

const pkg = (await Bun.file(file).json()) as Record<string, unknown>
const old = pkg.version

if (typeof old !== "string") {
  console.error("invalid package.json: missing string version")
  process.exit(1)
}

if (arg === "current") {
  console.log(old)
  process.exit(0)
}

const plain = /^(\d+\.\d+\.\d+)$/
const local = /^(\d+\.\d+\.\d+)-intsig\.(\d+)\.(\d+)$/

const parse = (v: string) => {
  const hit = local.exec(v)
  if (hit) {
    return {
      base: hit[1],
      n: Number(hit[2]),
      m: Number(hit[3]),
      kind: "local",
    }
  }

  const raw = plain.exec(v)
  if (raw) {
    return {
      base: raw[1],
      n: 0,
      m: 0,
      kind: "plain",
    }
  }

  return undefined
}

const sync = () => {
  const run = Bun.spawnSync(["git", "show", "origin/dev:packages/opencode/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (run.exitCode !== 0) {
    console.error("failed to read upstream version from origin/dev")
    console.error(Buffer.from(run.stderr).toString().trim())
    process.exit(1)
  }

  const txt = Buffer.from(run.stdout).toString()
  const hit = txt.match(/"version"\s*:\s*"([^"]+)"/)

  if (!hit) {
    console.error("failed to parse upstream package.json version")
    process.exit(1)
  }

  const base = hit[1].match(/^(\d+\.\d+\.\d+)/)
  if (!base) {
    console.error(`invalid upstream version: ${hit[1]}`)
    process.exit(1)
  }

  const cur = parse(old)
  const nm = cur?.kind === "local" ? `${cur.n}.${cur.m}` : "1.0"
  return `${base[1]}-intsig.${nm}`
}

const next =
  arg === "sync"
    ? sync()
    : (() => {
        const cur = parse(old)
        if (!cur) {
          console.error(`unsupported version format: ${old}`)
          process.exit(1)
        }
        return arg === "patch"
          ? cur.kind === "local"
            ? `${cur.base}-intsig.${cur.n}.${cur.m + 1}`
            : `${cur.base}-intsig.1.1`
          : cur.kind === "local"
            ? `${cur.base}-intsig.${cur.n + 1}.0`
            : `${cur.base}-intsig.2.0`
      })()

pkg.version = next
await Bun.write(file, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`${old} -> ${next}`)
