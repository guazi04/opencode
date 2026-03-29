---
name: release-note
description: "Generate opencode-intsig release notes and publish a version tag. Collect upstream sync changes and intsig-specific commits, format concise traceable bullets with upstream/intsig separation, then create tag and GitLab release. Triggers: 'release', 'tag', 'release note', '发版', '打tag', '发布', 'create release'."
---

# Release Note

This skill owns release content and publishing only.
Version numbers come from `version-management` via `bun run version:current`.
Do not bump version numbers in this skill.

## Phase 1: Determine Version Range

1. Fetch latest tags and release metadata:
   ```bash
   git fetch --tags origin
   ```
2. Resolve previous tag (if any):
   ```bash
   LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
   echo "$LAST_TAG"
   ```
3. Get `NEW_VERSION` from version-management output:
   ```bash
   NEW_VERSION=$(bun run version:current)
   echo "$NEW_VERSION"
   ```
4. Define range:
   ```bash
   if [ -n "$LAST_TAG" ]; then
     RANGE="${LAST_TAG}..HEAD"
   else
     RANGE="HEAD"
   fi
   echo "$RANGE"
   ```
   Do not run `version:patch`, `version:minor`, or `version:sync` here.

## Phase 2: Gather Changes Since Last Tag

Always skip:

- Merge commits in bullet generation
- CLA commits (`has signed the CLA`)
- Trivial chores: `chore:`, `ci:`, `test:`, `release:`, `ignore:`

### Step 2.1: Detect upstream sync merges

```bash
SYNC_MERGES=$(git log "$RANGE" --first-parent --merges --format='%H%x09%s' \
  | grep -E "sync/upstream-|Merge remote-tracking branch 'origin/dev'" || true)
echo "$SYNC_MERGES"
```

### Step 2.2: Extract upstream PRs per sync

For each sync merge commit `S`, inspect sync parent range `${S}^1..${S}^2`.

```bash
git log --first-parent --merges --format='%H%x09%s' "${S}^1..${S}^2" \
  | grep -E "Merge PR #[0-9]+|Merge pull request #[0-9]+"
```

Fallback for squash/rebase upstream flow:

```bash
git log --first-parent --no-merges --format='%H%x09%s' "${S}^1..${S}^2" \
  | grep -E "\(#[0-9]+\)|Merge pull request #[0-9]+"
```

Upstream categorization:

- Features: contains `feat`, `feature`, `add`, `support`, `introduce`
- Fixes: contains `fix`, `bug`, `resolve`, `patch`, `regression`

### Step 2.3: Extract intsig-specific commits

```bash
git log "$RANGE" --no-merges --format='%H%x09%an%x09%s'
```

Treat commit as intsig-specific only when it is not ancestor of origin/dev:

```bash
git merge-base --is-ancestor "$HASH" origin/dev
```

Exit code `0` -> upstream-originated, exclude from Intsig section.
Non-zero -> keep in Intsig section; if uncertain, fallback to author/message patterns (exclude CLA/bot and sync-merge texts).
Intsig categorization:

- Features: `feat(...)`, `feature`, `add`, `new`
- Fixes: `fix(...)`, `bug`, `resolve`, `hotfix`
- Other: remaining non-trivial commits

## Phase 3: Generate Release Notes

Use concise one-line bullets, no trailing period, include traceability numbers.
If no upstream sync in range, omit the entire `Upstream Sync` section.

```markdown
# v{version}

## Upstream Sync

同步上游 opencode {N} commits ({M} PRs)，主要变更：

### Features

- {one-line description} (#{pr_number})

### Fixes

- {one-line description} (#{pr_number})

## Intsig

### Features

- {one-line description} (#{issue}, !{mr})

### Fixes

- {one-line description} (#{issue}, !{mr})

### Upstream Contributions

- [PR #{number}]({url}): {one-line description}
```

Prioritize upstream items that are 强相关 to intsig: reported bugs, required dependencies, and areas touched during sync conflict resolution.

## Phase 4: Tag and Release

```bash
git tag "v${NEW_VERSION}"
git push intsig "v${NEW_VERSION}"
glab release create "v${NEW_VERSION}" --repo gitlab.intsig.net/iself-team/opencode --name "v${NEW_VERSION}" --notes "${RELEASE_NOTES_MD}"
```

For multiline notes, prefer notes file:

```bash
NOTES_FILE=$(mktemp)
cat > "$NOTES_FILE" <<'EOF'
{RELEASE_NOTES_MD}
EOF
glab release create "v${NEW_VERSION}" --repo gitlab.intsig.net/iself-team/opencode --name "v${NEW_VERSION}" --notes-file "$NOTES_FILE"
```

## Final Checks

- `NEW_VERSION` is obtained from `bun run version:current`
- Upstream and Intsig sections are separated correctly
- Bullets include `#` and `!` references when available
- `Upstream Sync` section omitted when no sync detected
- Tag and release names equal `v{NEW_VERSION}`
