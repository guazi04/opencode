import { expect, test } from "bun:test"
import prompt from "../../src/session/prompt/anthropic.txt"

test("anthropic prompt stays slim and keeps key directives", () => {
  expect(prompt).toContain("OpenCode")
  expect(prompt).toContain("TodoWrite")
  expect(prompt).toContain("system-reminder")
  expect(prompt).toContain("file_path:line_number")
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(5000)
  expect(prompt).not.toContain("<example>")
})
