import type { Session } from "@opencode-ai/sdk/v2/client"
import type { RootLoadArgs } from "./types"

const CHILD_BATCH = 8

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch {
    const result = await input.list({ directory: input.directory, roots: true })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}

export async function loadChildSessions(input: {
  directory: string
  roots: Session[]
  child: (query: { sessionID: string; directory: string }) => Promise<{ data?: Session[] }>
}) {
  const ids = [...new Set(input.roots.filter((s) => !!s?.id && !s.parentID).map((s) => s.id))]
  if (ids.length === 0) return [] as Session[]

  const groups = ids.reduce<string[][]>((all, id, i) => {
    const index = Math.floor(i / CHILD_BATCH)
    const group = all[index] ?? []
    group.push(id)
    all[index] = group
    return all
  }, [])

  const rows = await groups.reduce(
    async (all, group) => {
      const prev = await all
      const next = await Promise.allSettled(
        group.map((sessionID) => input.child({ sessionID, directory: input.directory })),
      )
      return [
        ...prev,
        ...next.flatMap((x) => {
          if (x.status !== "fulfilled") return []
          return x.value.data ?? []
        }),
      ]
    },
    Promise.resolve([] as Session[]),
  )

  return [...new Map(rows.filter((s) => !!s?.id).map((s) => [s.id, s])).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
}
