import { expect, test } from "bun:test"
import { Skill } from "../../src/skill"

const skills = [
  {
    name: "test-skill",
    description: "First sentence here. Second sentence with more details. Third.",
    location: "/path/to/SKILL.md",
    content: "# content",
  },
  {
    name: "simple-skill",
    description: "Just a short description",
    location: "/other/SKILL.md",
    content: "# content",
  },
]

test("returns empty message for empty list", () => {
  expect(Skill.fmt([], { verbose: false })).toBe("No skills are currently available.")
  expect(Skill.fmt([], { verbose: true })).toBe("No skills are currently available.")
})

test("formats verbose output without location and truncates description", () => {
  const out = Skill.fmt([skills[0]], { verbose: true })

  expect(out).toContain("<available_skills>")
  expect(out).toContain("  <skill>")
  expect(out).toContain("<name>test-skill</name>")
  expect(out).toContain("<description>First sentence here.</description>")
  expect(out).not.toContain("<location>")
})

test("formats markdown output and truncates description", () => {
  const out = Skill.fmt([skills[0]], { verbose: false })

  expect(out).toBe("## Available Skills\n- **test-skill**: First sentence here.")
})

test("returns description as-is when there is no period", () => {
  const out = Skill.fmt(
    [
      {
        name: "plain-skill",
        description: "Just a short description",
        location: "/plain/SKILL.md",
        content: "# content",
      },
    ],
    { verbose: false },
  )

  expect(out).toBe("## Available Skills\n- **plain-skill**: Just a short description")
})

test("caps long descriptions with ellipsis when there is no period", () => {
  const d = "a".repeat(201)
  const out = Skill.fmt(
    [
      {
        name: "long-skill",
        description: d,
        location: "/long/SKILL.md",
        content: "# content",
      },
    ],
    { verbose: false },
  )

  expect(out).toBe(`## Available Skills\n- **long-skill**: ${"a".repeat(200)}...`)
})

test("keeps trailing period without space unchanged", () => {
  const out = Skill.fmt(
    [
      {
        name: "dot-skill",
        description: "Something.",
        location: "/dot/SKILL.md",
        content: "# content",
      },
    ],
    { verbose: false },
  )

  expect(out).toBe("## Available Skills\n- **dot-skill**: Something.")
})

test("includes all skills in output", () => {
  const out = Skill.fmt(skills, { verbose: false })

  expect(out).toContain("- **test-skill**: First sentence here.")
  expect(out).toContain("- **simple-skill**: Just a short description")
})
