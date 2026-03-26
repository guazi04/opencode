---
name: version-management
description: "Auto-manage fork version numbers ({upstream}-intsig.N.M). Bump patch on every MR, minor on release, sync on upstream merge. Agents run version scripts automatically — humans never touch version numbers. Triggers: creating MR, 'release', '打tag', '发版', 'create release', 'tag version'."
---

# Version Management

Format: `{upstream_version}-intsig.N.M`

- `N` = local minor (features, larger changes)
- `M` = local patch (bugfixes, small tweaks)

All scripts run from `packages/opencode/`:

- `bun run version:patch` — M+1
- `bun run version:minor` — N+1, M=0
- `bun run version:sync` — update upstream base, preserve N.M
- `bun run version:current` — print current version

## Scenario 1: Regular MR (most common)

For **any** MR to `dev` (feature, fix, refactor):

1. Before the final commit on the branch, run:
   ```bash
   cd packages/opencode && bun run version:patch
   ```
2. Stage and commit the version bump (can be included in the last feature commit or as its own commit).
3. Include the bump in the MR — CI will fail if the version is unchanged vs `dev`.

**Exception**: skip if the branch is `sync/upstream-*` (sync has its own flow).

## Scenario 2: Upstream Sync

Handled automatically by the `sync-upstream-opencode` skill (Step 3.5 runs `version:sync`).
No additional action needed — the sync workflow already covers this.

## Scenario 3: Release / Tag

Triggered by: "release", "打tag", "发版", "create release", "tag version"

1. Run `version:minor` (N+1, M=0):
   ```bash
   cd packages/opencode && bun run version:minor
   ```
2. Commit the version change.
3. Create an MR to `dev` and merge it.
4. After merge, create the release tag on `dev`:
   ```bash
   git tag $(cd packages/opencode && bun run version:current)
   git push intsig --tags
   ```

## CI Verification

CI checks every MR to `dev`:

- Compares branch version against `dev` branch version
- Fails if version is unchanged (except `sync/upstream-*` branches)

Always bump proactively — don't rely on CI to catch a missing bump.
