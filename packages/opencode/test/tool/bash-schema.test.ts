import { describe, expect, test } from "bun:test"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { BashTool } from "../../src/tool/bash"

describe("tool.bash schema", () => {
  test("workdir schema stays path-agnostic", async () => {
    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        const tool = await BashTool.init()
        const schema = z.toJSONSchema(tool.parameters)
        const text = JSON.stringify(schema)

        expect(text).not.toMatch(/\/Users\//)
        expect(text).not.toMatch(/\/home\//)
        expect(text).not.toMatch(/\/tmp\//)
        expect(text).toContain("working directory")
      },
    })
  })
})
