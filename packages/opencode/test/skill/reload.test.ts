import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
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

test("Skill.reload refreshes skill and command caches", async () => {
  await using tmp = await tmpdir({ git: true })
  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await put(tmp.path, "alpha", "Alpha v1", "# Alpha\n\nAlpha v1 content.")
    await put(tmp.path, "beta", "Beta skill", "# Beta\n\nBeta content.")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = await Skill.get("alpha")
        expect(before?.description).toBe("Alpha v1")
        expect(before?.content).toContain("Alpha v1 content.")

        const first = await Command.list()
        expect(first.find((item) => item.name === "alpha")?.source).toBe("skill")
        expect(first.find((item) => item.name === "beta")?.source).toBe("skill")

        await put(tmp.path, "alpha", "Alpha v2", "# Alpha\n\nAlpha v2 content.")
        await put(tmp.path, "gamma", "Gamma skill", "# Gamma\n\nGamma content.")
        await fs.rm(path.join(tmp.path, ".opencode", "skill", "beta"), { recursive: true, force: true })

        await Skill.reload()

        const alpha = await Skill.get("alpha")
        expect(alpha?.description).toBe("Alpha v2")
        expect(alpha?.content).toContain("Alpha v2 content.")
        expect(await Skill.get("beta")).toBeUndefined()

        const skills = (await Skill.all()).map((item) => item.name).sort()
        expect(skills).toEqual(["alpha", "gamma"])

        const cmds = await Command.list()
        const names = cmds
          .filter((item) => item.source === "skill")
          .map((item) => item.name)
          .sort()
        expect(names).toEqual(["alpha", "gamma"])
        expect(cmds.find((item) => item.name === "alpha")?.description).toBe("Alpha v2")
        expect(cmds.find((item) => item.name === "beta")).toBeUndefined()
        expect(cmds.find((item) => item.name === "gamma")?.source).toBe("skill")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})
