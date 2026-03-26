---
name: sync-upstream-opencode
description: "Assess, plan, and execute upstream sync for the three-repo opencode architecture (origin → fork → intsig). Diagnoses drift, evaluates merge feasibility, resolves conflicts, and produces a structured sync report with impact analysis. Use when: (1) syncing upstream updates into intsig dev, (2) rebasing fork PR branches, (3) checking what's changed upstream, (4) evaluating conflict risk before merging, (5) merging selected fork patches into dev. Triggers: 'sync upstream', '同步上游', 'sync opencode', '同步opencode', 'update from upstream', '合并上游更新', 'rebase fork branches', '同步intsig'."
---

# Sync Upstream OpenCode

Assess drift between upstream and internal production, plan the merge, execute it via ephemeral sync branch and MR, and verify the result.

> 完整的分支模型和工作流规范见 `docs/git-workflow.md`（在 oh-my-iself 仓库）。

## Three-Repo Architecture

| Remote     | URL                                                 | Role                          |
| ---------- | --------------------------------------------------- | ----------------------------- |
| **origin** | `https://github.com/anomalyco/opencode.git`         | Official upstream (read-only) |
| **fork**   | `https://github.com/guazi04/opencode.git`           | PR submission source          |
| **intsig** | `https://gitlab.intsig.net/iself-team/opencode.git` | Internal production           |

### Branch Model

| Branch                   | Purpose                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev` (on intsig)        | **Protected integration branch**. All code enters via MR only. Contains upstream + our fixes. push_access_level=0, allow_force_push=false.                                     |
| `origin/dev`             | Upstream main branch. Tracked via remote ref only.                                                                                                                             |
| `sync/upstream-YYYYMMDD` | Ephemeral sync branch. Created from `dev`, merge `origin/dev`, MR back to `dev` (regular merge, not squash). Delete after merge. Same-day repeated syncs use `-1`/`-2` suffix. |
| `fix/*`, `feat/*`        | Individual patches. Submitted as upstream PRs via `fork` remote. MR to `dev` on intsig (squash merge).                                                                         |

**Key change from old model**: `intsig-dev` is retired. `dev` on intsig IS the integration branch. No more rebuilding from scratch — changes enter `dev` through MRs.

### Local Branch Convention

| Branch                  | Tracks       | Purpose                                                                    |
| ----------------------- | ------------ | -------------------------------------------------------------------------- |
| `dev`                   | `intsig/dev` | Protected integration branch. Checkout for creating sync/feature branches. |
| `upstream-dev-tracking` | `origin/dev` | Optional local ref for upstream. Used for diff/log comparisons.            |
| `fix/*`, `feat/*`       | `fork/*`     | Individual PR branches for upstream submission.                            |

Unlike the old model where `dev` was an upstream mirror and `intsig-dev` was the integration branch, now `dev` serves as the integration branch directly. Upstream is tracked via `origin/dev` remote ref.

---

## Situational Assessment

Before touching anything, build a complete picture of the current state.

### Fetch all remotes

```bash
git fetch --all
```

### Measure upstream drift

```bash
git log --oneline intsig/dev..origin/dev     # commits dev is behind upstream
git log --oneline origin/dev..intsig/dev     # our custom patches beyond upstream
```

Report:

- How many commits `dev` is behind `origin/dev` (0 = already current)
- What custom patches sit on top of `dev` beyond `origin/dev`

### Inventory fork PR branches

```bash
git branch -vv | grep -E 'fix/|feat/'
gh pr list --repo anomalyco/opencode --author guazi04 --state all \
  --json number,title,state,headRefName
```

For each fork branch, determine:

| Question                           | How to check                                          |
| ---------------------------------- | ----------------------------------------------------- |
| Is its PR still OPEN?              | `gh pr list` output                                   |
| Has the PR been MERGED upstream?   | `gh pr list --state merged` or check the PR page      |
| Was the PR CLOSED without merging? | `gh pr list --state closed`                           |
| Is the branch already in `dev`?    | `git log origin/dev..intsig/dev --oneline` for traces |

Classify each branch:

| PR Status  | Action                                                  |
| ---------- | ------------------------------------------------------- |
| **OPEN**   | Keep — rebase onto latest `origin/dev`                  |
| **MERGED** | Drop — upstream already has it, no need to keep in dev  |
| **CLOSED** | Ask user — was it superseded? still wanted internally?  |
| No PR yet  | Ask user — should a PR be opened, or is it intsig-only? |

### Check for upstream impact on our patches

```bash
# For each fork branch, check overlap with upstream changes
git diff origin/dev@{1}..origin/dev --stat   # what upstream changed
git diff origin/dev...<branch> --stat         # what our patch touches
```

Flag any fork branch whose changed files overlap with recent upstream changes — these are conflict candidates.

---

## Merge Feasibility Analysis

This is the critical step. Before committing to any merge, evaluate what will happen.

### Dry-run merge for upstream sync

```bash
git checkout -b test/sync-dry-run intsig/dev
git merge origin/dev --no-commit --no-ff
# inspect result
git merge --abort
git checkout -
git branch -D test/sync-dry-run
```

Record:

| Aspect           | Result                  |
| ---------------- | ----------------------- |
| Conflicts?       | Yes/No                  |
| Severity         | Trivial/Moderate/Severe |
| Files affected   | List                    |
| Auto-resolvable? | Yes/No                  |

### Dry-run rebase for each fork PR branch

For each active (OPEN PR) branch:

```bash
git checkout <branch>
git rebase origin/dev
# inspect result
git rebase --abort    # abort — this is just a test
```

For each branch, record:

| Branch | Conflicts? | Severity | Files affected | Auto-resolvable? |
| ------ | ---------- | -------- | -------------- | ---------------- |

### Conflict severity classification

| Severity     | Characteristics                                                  | Example                                       |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------- |
| **Trivial**  | Import reordering, whitespace, additive non-overlapping          | Upstream added imports near our added imports |
| **Moderate** | API signature changes, renamed symbols our patch uses            | Function parameter added/removed              |
| **Severe**   | File moved/deleted, structural rewrite of code our patch touches | Upstream rewrote the module we patched        |

### Present the feasibility report

Before proceeding, present findings to the user:

- Whether upstream merge into sync branch is clean or conflicted
- Which fork PR branches rebase cleanly onto latest upstream
- Conflict severity for each conflicted item
- Any branches that should be dropped (merged upstream or obsolete)

Wait for user confirmation before executing.

---

## Execution

Only proceed after assessment is clear and user has confirmed the plan.

### Step 1: Rebase fork PR branches (if any)

For each active (OPEN PR) branch:

```bash
git checkout <branch>
git rebase origin/dev
# resolve conflicts if any (see Conflict Resolution below)
git push fork <branch>    # default
# only with explicit user approval to bypass hooks (fork PR branches only)
git push fork <branch> --force-with-lease --no-verify
```

**Safety scope (strict)**:

- `--force-with-lease` / `--no-verify` **only** for fork PR branches (`fix/*`, `feat/*`) pushed to `fork` remote.
- **Never** use these flags on `dev`、`sync/*` 或任何受保护分支（包括 `intsig/dev`）。
- `--no-verify` 仅在用户明确批准后可用；且仅当失败可明确归因于上游代码问题而非我方改动。

### Step 2: Create upstream sync branch

```bash
git checkout dev
git pull intsig dev
git checkout -b sync/upstream-YYYYMMDD    # YYYYMMDD, e.g. sync/upstream-20260323; same-day repeats use -1/-2
```

### Step 3: Merge upstream

```bash
git fetch origin
git merge origin/dev
```

Resolve any conflicts (see Conflict Resolution Heuristics below).

### Step 3.5: Update fork version

After merging upstream, update the base version to match the new upstream version while preserving the local N.M increment:

```bash
cd packages/opencode
bun run version:sync
cd ../..
git add packages/opencode/package.json
```

This runs automatically — no human action needed. The version change will be included in the sync MR commit.

> **Version format**: `{upstream}-intsig.N.M` where N.M is our local increment. `version:sync` reads the upstream version from `origin/dev` and updates the base while preserving N.M. Example: `1.3.2-intsig.3.2` → `1.4.0-intsig.3.2`.

### Step 4: Verify and push sync branch

Run Phase 1 verification (see Post-Merge Review Protocol), then:

```bash
git push intsig sync/upstream-YYYYMMDD
```

### Step 5: Create MR

```bash
glab mr create --source-branch sync/upstream-YYYYMMDD --target-branch dev \
  --title "sync: merge upstream YYYY-MM-DD" \
  --description "Upstream sync. See commit log for details." \
  --repo iself-team/opencode
```

**Merge method**: Regular merge (NOT squash) — to preserve upstream commit history.

### Step 6: Merge fork patches (if any need to enter dev)

For each fork fix that should be in the integration branch, create a separate MR:

```bash
git push intsig <branch>
glab mr create --source-branch <branch> --target-branch dev \
  --title "<branch description>" \
  --repo iself-team/opencode
```

**Merge method**: Squash merge — clean single-commit for each patch.

### Step 7: After MRs are merged

```bash
git checkout dev
git pull intsig dev
git branch -d sync/upstream-YYYYMMDD
git push intsig --delete sync/upstream-YYYYMMDD
```

---

## Structural Divergences

Record known architectural divergences between upstream and the `dev` integration branch. These are not file conflicts. They are cases where functionality is equivalent but file structure or layering is different.

### Current Known Divergences

| Upstream Area | dev Implementation | Divergence Type | Porting Notes                                                      |
| ------------- | ------------------ | --------------- | ------------------------------------------------------------------ |
| _None yet_    | _None yet_         | _None yet_      | Add rows as soon as the first structural divergence is discovered. |

### Handling Rules

- After each upstream sync merge, compare every divergence point manually.
- Port all new upstream logic branches, function calls, and parameters into our reorganized or extended implementation.
- Passing typecheck and tests is **not sufficient**. Structural divergence omissions are runtime semantic issues that compile-time checks can miss.

### Maintenance Requirement

When a new structural divergence appears, add it to this table immediately with concrete file paths and porting notes.

## Cross-Contamination Checklist

When `dev` has custom logic in shared files (from merged fork patches), new upstream code paths in those same files may bypass our logic.

### After merge must check

1. List all custom logic in shared files that our patches added (exclude intsig-only files).
2. Inspect all new upstream code paths in those same files (new functions, new branches, new callbacks).
3. Determine whether each new upstream path must call or account for our custom logic.
4. Reverse-check our custom logic against upstream changes: confirm it handles new parameters, new fields, and new lifecycle states.
5. Focus on cleanup/dispose paths, error handling, retry/fallback paths, and lifecycle callbacks.

### Typical Case Study

Our dev adds custom cleanup logic in a shared manager module. Upstream later introduces a new early-return error path in the same module. The new path skips cleanup, so stale state accumulates. Typecheck and tests still pass, but runtime behavior degrades over time. Fix by wiring cleanup into the new path and updating the helper to handle the new upstream payload shape.

---

## Verification & Sync Report

After execution, run the full post-merge review protocol and produce a structured report.

### Three-Phase Post-Merge Review Protocol

#### Phase 1: Automated Verification (required for all syncs)

Run from `packages/opencode`:

```bash
bun typecheck
bun test
```

Also verify app package:

```bash
# Also verify app package
cd packages/app && bun typecheck
```

Then validate sync state:

```bash
echo "=== dev ===" && git log --oneline -5 dev
echo "=== intsig/dev (remote) ===" && git log --oneline -5 intsig/dev
```

Confirm:

- ✅ `packages/app` typecheck passes
- ✅ `dev` is up to date with `intsig/dev`
- ✅ Upstream commits are present in `dev` after sync MR merge
- ✅ All active fork branches rebased on latest `origin/dev`

If typecheck or tests fail, do not proceed to MR. Diagnose attribution first (see Breaking Change Triage).

#### Phase 2: Oracle Semantic Review (required for large syncs: 50+ upstream commits)

Use Oracle for semantic review with focus on:

- Structural divergence porting completeness
- Cross-contamination coverage between upstream new paths and our custom logic
- Merge conflict decisions that may have dropped behavior

Oracle prompt should include:

- File pairs or modules to compare
- Structural Divergences table entries
- Shared-file custom logic inventory
- Conflict resolution decision log

#### Phase 3: Fact Verification (required after Oracle review)

Oracle can hallucinate. Verify every Oracle finding with tools:

1. Read the exact file and line range Oracle flagged.
2. Compare against upstream source (`git show origin/dev:<file>` or relevant commit) to confirm missing or changed behavior is real.
3. Reassess severity (Oracle can overstate or understate impact).
4. Distinguish real bugs from intentional divergence.

Only findings confirmed in Phase 3 become action items.

### Large Sync Protocol

When upstream delta is large (50+ commits or 100+ changed files), additionally execute:

1. **Pre-merge analysis**: map high-risk files with `git log --oneline intsig/dev..origin/dev` and `git diff --stat intsig/dev...origin/dev`.
2. **During merge**: log each non-trivial resolution decision (file, chosen side, rationale, follow-up risk).
3. **Post-merge review**: complete all Phase 1-3 checks before sign-off.
4. **Report extension**: include dedicated "Structural Divergence Porting" and "Cross-Contamination Check" sections.

### Upstream Changes Summary

```bash
git log --oneline intsig/dev..origin/dev    # before sync, shows what will be merged
```

Group changes by type: **features**, **fixes**, **refactors**, **docs**, **tests**, **deps**, **breaking changes**.

### Fork Branch Status

| Branch   | PR#  | Status | Rebase Result        | In dev?    |
| -------- | ---- | ------ | -------------------- | ---------- |
| fix/xxx  | #123 | OPEN   | ✅ clean             | ✅ yes     |
| feat/yyy | #456 | OPEN   | ⚠️ conflict resolved | ❌ PR only |
| fix/zzz  | #789 | MERGED | dropped              | —          |

### Conflicts Resolved

For each conflict encountered, document:

- **File**: Path to conflicted file
- **Cause**: What upstream changed vs what our patch does
- **Severity**: Trivial / Moderate / Severe
- **Resolution**: Auto-resolved / Adapted our code / User decision
- **Attribution**: Upstream change (commit hash) vs our patch (branch name)

### Structural Divergence Porting (large syncs)

For each row in the Structural Divergences table:

- Confirm upstream changes were reviewed
- Confirm equivalent logic was ported into dev implementation
- Note any uncertain cases requiring manual runtime validation

### Cross-Contamination Check (large syncs)

For shared files with custom logic from our patches:

- List upstream new paths reviewed
- Confirm whether custom logic coverage was updated where required
- Record any uncovered paths and required follow-up fixes

### Impact on intsig Patches

Check if upstream changes touch areas that our patches modify. Flag anything that:

- Changes APIs our patches call
- Moves/renames files our patches touch
- Alters behavior our patches depend on

### Breaking Change Triage

If build, typecheck, or tests fail after sync, diagnose attribution before asking the user to fix it.

**Upstream issue** — The upstream commit itself introduced the breakage.

- Check: Does upstream's CI pass on `origin/dev`? Does the failure exist on a clean upstream checkout?
- If yes → upstream is broken. Suggest filing an issue at `https://github.com/anomalyco/opencode`.

**Integration issue** — Our patches are incompatible with upstream changes.

- Check: Our code compiles alone, upstream compiles alone, but together they break.
- If yes → we need to adapt our patches. Suggest tracking in GitLab: `https://gitlab.intsig.net/iself-team/opencode`.

**Our issue** — Pre-existing problem in our patches unrelated to the sync.

- Check: Did this error exist before the sync? Is it in our patch-specific code?
- If yes → pre-existing, fix separately.

### Action Items

List follow-up work: e.g., "upstream changed X API — patch `fix/bar` needs adaptation" or "PR #123 merged upstream — drop `fix/foo` from dev" or "no action items, clean sync."

---

## Conflict Resolution Heuristics

### Common Patterns

| Pattern                     | Cause                                                                                            | Resolution                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Import section conflicts    | Upstream refactoring adds new imports at same location as ours                                   | Keep both — upstream imports AND our imports                                                                                           |
| `package.json` / `bun.lock` | Version bumps                                                                                    | Take upstream versions; keep any intsig-only entries                                                                                   |
| API signature changes       | Upstream changed function signatures our patches use                                             | Adapt our code to new API                                                                                                              |
| File moved/renamed          | Upstream reorganized code                                                                        | Reapply our patch to new location                                                                                                      |
| Config/schema additions     | Both sides added new config keys                                                                 | Keep both — they should be distinct                                                                                                    |
| Cross-file type dependency  | Taking `--theirs` on a file breaks non-conflicted callers that depend on removed/changed exports | After resolving with `--theirs`, check all importing files for type compatibility. Run app-wide typecheck, not just on conflict files. |
| `package.json` version field | Upstream bumped version, we have `-intsig.N.M` suffix | Run `bun run version:sync` — it reads upstream base and preserves our N.M |

### Resolution Strategy

1. **Auto-resolvable**: Import additions, additive changes → keep both sides
2. **Needs adaptation**: Our code uses old API → update our code to match upstream patterns
3. **Needs user input**: Structural conflicts, unclear intent → stop and describe the conflict

For non-trivial conflicts, describe to the user:

- Which file(s) are in conflict
- What the upstream change is (`git show MERGE_HEAD -- <file>` during merge conflicts)
- What our version contains
- Suggested resolution

---

## Constraints

- **`dev` is protected** — push_access_level=0, allow_force_push=false. All changes via MR.
- **Upstream sync uses regular merge** — NOT squash, to preserve upstream commit history
- **Fork patches use squash merge** — clean single-commit per patch
- **Never force-push to `dev`** — branch protection prevents this
- **Fork Actions are disabled** — don't re-enable them
- **Fork PR branches use `fork` remote** — never push PR branches to `origin` or `intsig`
- **`--force-with-lease` / `--no-verify` scope limit** — only allowed on fork PR branches pushed to `fork`; never on `dev`/`sync/*`/protected branches
- **`--no-verify` requires explicit user approval** — no implicit or automatic bypass of hooks
- **GitLab branch protection** — `dev` on intsig is protected. Changes only via MR.
- **Do NOT push automatically** — after reporting results, wait for user approval before creating MRs

---

## 1. Custom Patches Inventory

Track all custom patches on `dev` not present upstream. Every sync MUST verify each patch survives.

| Patch                          | Files                                                                                   | Purpose                                           | Risk During Sync                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Idle timeout (10min)           | `processor.ts`                                                                          | Kill hung LLM streams after 10min silence         | HIGH — processor.ts is frequently changed upstream                                    |
| Near-max truncation            | `message-v2.ts`                                                                         | Smarter token budget near context limit           | MEDIUM — message handling logic changes                                               |
| Tool-input streaming           | `processor.ts`                                                                          | Stream tool inputs as they arrive                 | HIGH — same file as idle timeout                                                      |
| DB lifecycle fix               | `db.bun.ts`                                                                             | Proper DB connection cleanup                      | LOW — Bun-specific, upstream moving to Node                                           |
| Plugin dedup                   | `plugin/index.ts`                                                                       | Prevent duplicate plugin loading                  | LOW — additive change                                                                 |
| Session tree + sidebar UI      | `session/index.ts`, `sidebar-items.tsx`, `sidebar-workspace.tsx`, `sidebar-project.tsx` | Parent-child session tracking + tree UI rendering | HIGH — upstream dropped child-tree props in sidebar, our callers still depend on them |
| Truncation cascade diagnostics | `processor.ts`, `message-v2.ts`                                                         | Detailed logging for compaction issues            | HIGH — touches hot files                                                              |

---

## 2. Known Integration Gotchas

Common post-merge issues we've encountered:

### Version field in package.json

- **File**: `packages/opencode/package.json`
- **Issue**: Our version uses `{upstream}-intsig.N.M` format. Upstream version bumps will always conflict with our version field.
- **Check**: After merge, run `bun run version:sync` (Step 3.5 handles this automatically). Verify with `bun run version:current`.

### Config dependency install scope

- **File**: `config/config.ts`
- **Issue**: Upstream's dependency install logic may apply to broader scope than intended
- **Check**: Verify `installDeps` only runs for the correct package scope

### isLocal() VERSION check

- **File**: `installation/index.ts`
- **Issue**: `isLocal()` may not check `VERSION=local` env var
- **Check**: Ensure local development detection works correctly

### Semver parsing on "local" version

- **File**: `bun/registry.ts`
- **Issue**: Semver parse crashes on non-semver version strings like "local"
- **Check**: Ensure version parsing has guards for non-standard version strings

### Mock contamination in tests

- **File**: `test/session/compaction-restore.test.ts`
- **Issue**: `mock.module()` leaks globally across test files when not properly scoped
- **Check**: Ensure mocks are scoped with `beforeEach`/`afterEach` or `using` blocks

### Effect service initialization order

- **Issue**: After upstream Effect-ification, service initialization order may matter
- **Check**: If tests fail with "service not found", check Effect layer composition

### Sidebar child-session tree props

- **Files**: `sidebar-items.tsx`, `sidebar-project.tsx`, `sidebar-workspace.tsx`
- **Issue**: Upstream may drop child-session tree props (`child`, `hasChild`, `openChild`, `onChildToggle`) from `SessionItemProps` as they don't use session trees. Our sidebar callers still depend on these.
- **Check**: After any sidebar conflict resolution, verify `SessionItemProps` still includes child-tree props and `children` map typing matches (`Map<string, Session[]>`)

---

## 3. Sync Scale Strategy

Choose approach based on upstream commit count:

| Scale      | Commits | Approach                                                               |
| ---------- | ------- | ---------------------------------------------------------------------- |
| Small      | 1-20    | Direct merge, Phase 1 review only                                      |
| Medium     | 20-50   | Direct merge, Phase 1 + spot-check Phase 2                             |
| Large      | 50-100  | Direct merge, Full Phase 1-3 review, document all conflict resolutions |
| Very Large | 100+    | Consider cherry-pick strategy or staged merges by topic area           |

### Large Sync Checklist (50+ commits)

1. Pre-merge: Full Custom Patches Inventory check
2. During merge: Document every conflict resolution with rationale
3. Post-merge Phase 1: typecheck + test (mandatory)
4. Post-merge Phase 2: Oracle semantic review (mandatory for 50+ commits)
5. Post-merge Phase 3: Tool-verified fact-checking of Oracle findings
6. Post-merge: Cross-contamination check on all shared files
7. Post-merge: Structural divergence porting verification

---

## 4. Structural Divergences Registry

| Area                 | Upstream Approach                                 | Our Approach                     | Files                                   | Last Verified       |
| -------------------- | ------------------------------------------------- | -------------------------------- | --------------------------------------- | ------------------- |
| DB abstraction       | `#db` conditional import (db.bun.ts / db.node.ts) | Same (inherited)                 | `storage/db.*.ts`                       | 2026-03-23          |
| Process spawning     | `ChildProcessSpawner` Effect service              | Mixed (some Bun.spawn remains)   | `cli/cmd/*.ts`                          | 2026-03-23          |
| Sleep/timers         | `timers/promises` setTimeout                      | Some files still use `Bun.sleep` | Various                                 | 2026-03-23 — fixing |
| Service architecture | Effect-ified services with layers                 | Same (inherited from sync)       | `src/session/*.ts`, `src/provider/*.ts` | 2026-03-23          |

---

## 5. Diagnostic Playbook

### Typecheck fails after merge

1. Check if it's an upstream issue: `git stash && git checkout origin/dev && bun typecheck`
2. Check if it's our patch: look at error file — is it in our custom code?
3. Common fix: import path changes, API signature updates

### Tests fail after merge

1. Run the specific failing test in isolation: `bun test <file>`
2. Check for mock contamination (most common cause)
3. Check for Effect service initialization issues
4. Check for hardcoded paths/values that upstream changed

### Runtime errors after merge (not caught by tests)

1. Check Custom Patches Inventory — did a patch get partially overwritten?
2. Check Structural Divergences — did upstream change logic we forked?
3. Run with `DEBUG=*` to get detailed logs

---

## 6. Agent Delegation Template

When Self delegates sync work, use this template structure:

### For Hephaestus (merge execution):

- Goal: Execute upstream sync merge on branch `sync/upstream-MMDD`
- Scope: All packages, focus on `packages/opencode/src`
- Constraints: Regular merge (not squash), preserve upstream history, do NOT push, do NOT run `bun run build` (too slow; `bun typecheck` is sufficient)
- Custom patches to preserve: [list from inventory]
- Verification: `bun typecheck` + `bun test` in `packages/opencode`

### For Oracle (post-merge semantic review):

- Goal: Review merge result for semantic correctness
- Focus areas: Structural divergences, cross-contamination, custom patch survival
- Provide: diff of merge commit, list of custom patches, known divergences

---

## 7. Sync History

Record each sync for trend analysis and pattern recognition.

| Date       | Upstream Commits | Conflicts | Severity                                                                                | Integration Fixes                         | Notes                                                                                                                                                                                              |
| ---------- | ---------------- | --------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-18 | 53               | 3         | 3 moderate (provider.ts, llm.ts, llm.test.ts)                                           | 1                                         | Sync to v1.2.27. Effect化重构, permission新字段, bun info超时修复. Reverted 2 unauthorized agent commits.                                                                                          |
| 2026-03-23 | 95               | 8         | 2 severe, 3 moderate, 3 trivial                                                         | 4                                         | First large sync. Effect-ification, service facade flattening, Node.js portability, GitLab Agent Platform.                                                                                         |
| 2026-03-25 | 70               | 5         | 3 trivial (sidebar-items, sidebar-project, prompt.test), 2 moderate (llm.ts, prompt.ts) | 1 (sidebar child-session type compat fix) | Sync to v1.3.2. More effectify (Worktree, Project, agent.ts), plugin robustness overhaul, beta conflict resolver. App typecheck broke after --theirs on sidebar — cross-file type dependency trap. |

---

## 8. Upstream Trends

Track recurring upstream patterns to anticipate future sync friction.

### Active Trends (as of 2026-03-25)

- **Effect-ification**: Migrating services to Effect framework (Pty, Installation, Plugin, Command, SessionStatus, Worktree now done). Trend is accelerating — 3 more core services landed in one sync cycle.
- **Node.js portability**: Replacing Bun-specific APIs with cross-runtime alternatives. Our Bun-only code will increasingly diverge.
- **Service facade flattening**: Moving state from services to InstanceState, breaking import cycles. May affect our custom service interactions.
- **GitLab integration**: GitLab is actively contributing (Agent Platform). More GitLab-specific code expected.
- **Provider ecosystem**: New providers being added regularly (Gateway, Vercel, etc.)

### Friction Forecast

- `processor.ts` will remain HIGH friction — it's the core processing loop and both sides modify it heavily
- `llm.ts` MEDIUM friction — upstream is adding provider-specific logic
- `provider.ts` MEDIUM friction — provider ecosystem expanding rapidly
- `message-v2.ts` MEDIUM friction — our truncation logic vs upstream message handling changes
