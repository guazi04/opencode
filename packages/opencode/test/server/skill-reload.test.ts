import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

async function put(root: string, name: string, description: string, body: string) {
  const dir = path.join(root, ".opencode", "skill", name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

${body}
`,
  )
}

test("POST /skill/reload refreshes skills and commands", async () => {
  await using tmp = await tmpdir({ git: true })
  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await put(tmp.path, "alpha", "Alpha skill", "# Alpha\n\nAlpha content.")

    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path }

    const first = await app.request("/skill", { headers })
    expect(first.status).toBe(200)
    const before = (await first.json()) as Array<{ name: string }>
    expect(before.map((item) => item.name)).toEqual(["alpha"])

    await put(tmp.path, "beta", "Beta skill", "# Beta\n\nBeta content.")
    await fs.rm(path.join(tmp.path, ".opencode", "skill", "alpha"), { recursive: true, force: true })

    const reload = await app.request("/skill/reload", {
      method: "POST",
      headers,
    })
    expect(reload.status).toBe(200)
    const body = (await reload.json()) as {
      ok: boolean
      skill_count: number
      command_count: number
    }
    expect(body.ok).toBe(true)
    expect(body.skill_count).toBe(1)

    const skillRes = await app.request("/skill", { headers })
    expect(skillRes.status).toBe(200)
    const skills = (await skillRes.json()) as Array<{ name: string }>
    expect(skills.map((item) => item.name)).toEqual(["beta"])

    const cmdRes = await app.request("/command", { headers })
    expect(cmdRes.status).toBe(200)
    const cmds = (await cmdRes.json()) as Array<{ name: string; source?: string }>
    const names = cmds
      .filter((item) => item.source === "skill")
      .map((item) => item.name)
      .sort()
    expect(names).toEqual(["beta"])
    expect(body.command_count).toBe(cmds.length)
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})
