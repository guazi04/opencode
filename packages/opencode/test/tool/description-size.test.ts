import { describe, expect, test } from "bun:test"
import bash from "../../src/tool/bash.txt"
import multiedit from "../../src/tool/multiedit.txt"
import todowrite from "../../src/tool/todowrite.txt"

const bytes = (text: string) => new TextEncoder().encode(text).length

describe("tool description size", () => {
  test("stays under budget", () => {
    expect(bytes(multiedit)).toBeLessThan(1600)
    expect(bytes(todowrite)).toBeLessThan(1200)
    expect(bytes(bash)).toBeLessThan(2100)
  })

  test("keeps critical rules", () => {
    expect(bash).toContain("NEVER")
    expect(multiedit).toContain("atomic")
  })
})
