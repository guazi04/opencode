import { test, expect } from "bun:test"

test("registry.ts sorts custom tools", async () => {
  const src = await Bun.file("src/tool/registry.ts").text()
  expect(src).toContain("custom.toSorted(")
})

test("prompt.ts sorts MCP tool entries", async () => {
  const src = await Bun.file("src/session/prompt.ts").text()
  const lines = src.split("\n")
  const mcpLine = lines.find((l) => l.includes("mcp.tools()"))
  expect(mcpLine).toBeDefined()
  expect(mcpLine).toContain(".sort(")
})
