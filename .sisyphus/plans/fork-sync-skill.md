# Fork Sync Skill Development Plan

**Goal:** Build a new OpenCode skill, tentatively named `fork-sync`, that can discover forked repos, report divergence from upstream, safely sync upstream changes into local forks, intelligently resolve conflicts by analyzing duplicate logic between local and upstream changes, and produce human-readable summaries without losing local customizations.

**Constraints:** Plan only. Do not implement the skill yet. Create files only under `~/.opencode/skills/fork-sync/` during later execution. Linux only. Use existing OpenCode skill conventions: `SKILL.md`, helper scripts run via `uv run`, optional `references/`, `workflows/`, `templates/`, and tool-style orchestration.

**Primary execution target:** A follow-up OpenCode agent should be able to use this file as the implementation prompt.

---

## Outcome Definition

The finished skill should let an agent do four things reliably:

1. `scan` — discover candidate git repos under a root, identify which are forks, and record upstream metadata.
2. `status` — summarize fork health for one repo or many repos: branch mapping, ahead/behind counts, dirty state, missing remotes, and sync readiness.
3. `sync` — perform a guarded upstream sync using merge or rebase while preserving local commits and leaving clear rollback points.
4. `report` — render a human-readable summary of divergence, commands run, sync results, conflicts, and next actions.

Success means the skill is safe-by-default, explicit about risk, and useful both for a single repo and a directory full of forks.

---

## Proposed Skill Architecture

### Target path

```text
~/.opencode/skills/fork-sync/
├── SKILL.md
├── tools/
│   ├── scan.py
│   ├── status.py
│   ├── sync.py
│   ├── report.py
│   └── common.py
├── workflows/
│   ├── scan.md
│   ├── status.md
│   ├── sync.md
│   └── report.md
├── references/
│   ├── safety-checks.md
│   ├── git-strategy.md
│   └── output-format.md
└── templates/
    ├── repo-report.md
    └── fleet-report.md
```

### File responsibilities

- `~/.opencode/skills/fork-sync/SKILL.md`
  - YAML frontmatter: `name`, `description`
  - Router-style intake for `scan`, `status`, `sync`, `report`
  - Core principles: safety first, no destructive defaults, Linux-only assumptions, prefer merge unless user explicitly requests rebase
  - Command examples showing `uv run ~/.opencode/skills/fork-sync/tools/<script>.py`
- `~/.opencode/skills/fork-sync/tools/common.py`
  - Shared helpers for subprocess execution, repo validation, JSON output, parsing remotes, branch detection, ahead/behind counts, and report models
- `~/.opencode/skills/fork-sync/tools/scan.py`
  - Recursive discovery of git repos from a root path
  - Fork detection from git remotes + optional `gh repo view` enrichment
- `~/.opencode/skills/fork-sync/tools/status.py`
  - Per-repo divergence summary, cleanliness checks, upstream branch mapping, sync recommendation
- `~/.opencode/skills/fork-sync/tools/sync.py`
  - Pre-flight validation, backup branch creation, optional stash, fetch, merge/rebase orchestration, conflict detection, rollback instructions
- `~/.opencode/skills/fork-sync/tools/report.py`
  - Convert JSON/tool output into human-readable markdown/plain-text reports for one repo or many repos
- `~/.opencode/skills/fork-sync/workflows/*.md`
  - Agent-facing steps for invoking each tool and interpreting results
- `~/.opencode/skills/fork-sync/references/*.md`
  - Stable guidance on merge vs rebase, required safety gates, and output conventions
- `~/.opencode/skills/fork-sync/templates/*.md`
  - Reusable report shapes to keep summaries consistent

### Data model to standardize early

Every tool should converge on the same repo record shape so the agent can compose outputs:

```json
{
  "path": "/home/yevhenii/Projects/Claude-fork",
  "repo": "owner/name",
  "is_git": true,
  "is_fork": true,
  "default_branch": "dev",
  "current_branch": "feature/x",
  "origin": "git@github.com:user/fork.git",
  "upstream": "git@github.com:upstream/original.git",
  "upstream_branch": "dev",
  "dirty": false,
  "ahead": 3,
  "behind": 12,
  "sync_mode": "merge",
  "sync_ready": true,
  "warnings": [],
  "errors": []
}
```

Keep JSON as the machine contract; let `report.py` and the agent turn it into prose.

---

## Command Surface To Plan Around

### Repo discovery and metadata

- `git rev-parse --is-inside-work-tree`
- `git remote -v`
- `git branch --show-current`
- `git symbolic-ref refs/remotes/origin/HEAD`
- `git config --get remote.origin.url`
- `git config --get remote.upstream.url`
- `gh repo view --json nameWithOwner,isFork,parent,defaultBranchRef,url`

### Divergence and cleanliness

- `git status --porcelain`
- `git fetch --all --prune`
- `git rev-list --left-right --count HEAD...upstream/<branch>`
- `git log --oneline --left-right HEAD...upstream/<branch>`
- `git diff --stat HEAD..upstream/<branch>`
- `git merge-base HEAD upstream/<branch>`

### Sync execution

- `git stash push -u -m "fork-sync preflight <timestamp>"`
- `git branch fork-sync-backup/<branch>-<timestamp>`
- `git fetch upstream --prune`
- `git merge --no-ff upstream/<branch>`
- `git rebase upstream/<branch>`
- `git rebase --abort`
- `git merge --abort`
- `git stash pop`
- `git push`
- `git push --force-with-lease`

### GitHub-specific fork sync shortcut

- `gh repo sync -b <branch>`
- Treat `gh repo sync --force` as disallowed by default; only mention it in references as a last-resort recovery path, not a normal workflow.

---

## Core Workflows

## Workflow 1: `scan`

### Objective

Discover all git repos under a root and determine which ones are likely forks and what upstream they track.

### Planned behavior

- Accept a root directory such as `~/Projects`
- Walk the tree looking for `.git` directories without descending into nested git internals
- For each repo:
  - confirm it is a git worktree
  - collect `origin` and `upstream` remotes
  - if `upstream` exists, mark as fork candidate
  - if `upstream` is absent but `gh repo view` says `isFork=true`, mark as fork missing upstream
  - capture default branch from `gh` when available, otherwise infer from origin/upstream HEAD
- Emit both table-friendly text and JSON

### Output classes

- Healthy fork with upstream configured
- Fork missing upstream remote
- Normal repo, not a fork
- Local repo with insufficient metadata
- Repo skipped due to permission or command failure

### Verification

- Scanning a directory with mixed repos returns stable classifications
- Repos without `gh` auth still work via git-only fallback
- Non-fork repos are not falsely marked as sync candidates

---

## Workflow 2: `status`

### Objective

Show divergence summary for one repo or all scanned forks.

### Planned behavior

- For each target repo:
  - validate `upstream` remote or GitHub parent metadata
  - fetch remotes unless `--no-fetch` is requested
  - detect working tree dirtiness from `git status --porcelain`
  - map local branch to sync branch; default to repo default branch
  - compute ahead/behind counts against `upstream/<branch>`
  - collect concise log/diff summaries for human reading
- Return a sync readiness state such as:
  - `ready`
  - `dirty-tree`
  - `missing-upstream`
  - `no-upstream-branch`
  - `diverged-with-local-commits`
  - `conflict-risk`

### Suggested human summary fields

- repo path
- fork parent
- current branch
- sync branch
- ahead/behind counts
- dirty/clean
- recommended action: none, fetch-only, merge-sync, rebase-sync, manual-review

### Verification

- Ahead/behind counts match manual `git rev-list --left-right --count`
- Dirty repos are flagged without mutating state
- Missing upstream branches generate actionable errors

---

## Workflow 3: `sync`

### Objective

Safely apply upstream changes to a fork while preserving local commits and making rollback straightforward.

### Default mode

- Default to `merge`
- Allow `rebase` only when requested or configured in the skill call
- Never use hard reset or bare `--force`

### Planned sync sequence

1. Validate repo and target branch
2. Refuse to run if repo is not a fork candidate
3. Refuse destructive actions on detached HEAD
4. Check dirty tree
5. If dirty and `--auto-stash` enabled, create stash; otherwise stop with guidance
6. Create backup branch: `fork-sync-backup/<branch>-<timestamp>`
7. Fetch `upstream` and `origin`
8. Recompute ahead/behind after fetch
9. If behind is zero, report no-op and exit cleanly
10. Run merge or rebase:
    - merge: `git merge --no-ff upstream/<branch>`
    - rebase: `git rebase upstream/<branch>`
11. Detect conflicts immediately
12. If conflict:
    - classify each conflict (duplicate solution, complementary, cosmetic, true conflict)
    - auto-resolve duplicate/complementary/cosmetic conflicts using the intelligent resolution strategy
    - for true conflicts: leave markers, annotate report with both sides' intent and recommended resolution
    - if all conflicts resolved: `git add .` and continue merge/rebase
    - if unresolvable conflicts remain: keep backup branch and stash intact, provide exact resume/abort commands
    - validate auto-resolutions with available linters/type checks; revert if broken
13. If success and stash exists, restore with `git stash pop`
14. Produce a report of commits introduced and local commits preserved
15. If rebase changed published history, recommend `git push --force-with-lease`

### Sync policy decisions to encode in skill docs

- Merge is the safe default for most agents and preserves branch history
- Rebase is allowed for personal forks but must surface the push implication clearly
- `gh repo sync` can be used only for the narrow fast-forward case where local branch has no unique commits; otherwise prefer explicit git flow

### Verification

- Clean behind-only fork merges without losing local branch state
- Rebase path aborts cleanly on conflict
- Backup branch exists before any history rewrite begins
- Dirty tree never gets mutated without explicit stash or user-approved handling

---

## Workflow 4: `report`

### Objective

Generate readable summaries for a single repo sync or a fleet status run.

### Report sections

- repo identity and upstream
- pre-flight findings
- branch divergence
- operation chosen: scan, status, merge-sync, rebase-sync
- commands executed
- upstream commits incorporated
- local commits preserved or rewritten
- conflicts, if any
- push guidance
- rollback guidance

### Two report modes

- Per-repo detailed report using `templates/repo-report.md`
- Fleet overview using `templates/fleet-report.md`

### Verification

- Reports are readable without looking at raw command output
- Error cases still produce a full summary with next steps
- Reports can be emitted as markdown and plain text

---

## Safety Mechanisms

### Non-negotiable pre-flight checks

Before any sync action, the skill must validate:

1. target path exists and is a git repo
2. `upstream` remote exists or can be derived from GitHub fork metadata
3. target branch exists locally and on upstream
4. worktree state is known (`clean`, `dirty`, `untracked-only`, `conflicted`)
5. no merge or rebase is already in progress
6. current branch is not detached
7. backup branch name is available
8. push behavior after sync is known in advance

### Required rollback assets

- Backup branch before merge/rebase
- Optional stash before sync when dirty tree handling is enabled
- Explicit abort path:
  - merge: `git merge --abort`
  - rebase: `git rebase --abort`
- Recovery path documented in report:
  - `git reset --hard fork-sync-backup/<branch>-<timestamp>` should be documented as a manual emergency command, not run automatically by the skill

### Destructive-operation policy

- Never run `git reset --hard` automatically
- Never run `git push --force`
- Only recommend `git push --force-with-lease` after successful rebase when needed
- Never delete stash or backup branches automatically during initial versions
- Auto-resolve conflicts only when classification is confident (duplicate, complementary, cosmetic); flag true conflicts for human review

### Conflict handling plan — Intelligent Resolution

When merge/rebase conflicts occur, the agent should NOT simply stop. Instead, it should analyze and attempt resolution:

#### Step 1: Detect and classify conflicts

- detect via non-zero exit plus repo state checks
- collect conflicted files from `git status --porcelain`
- record whether operation is merge or rebase

#### Step 2: Analyze each conflict for duplicate logic

For each conflicted file, the agent must:

- extract both sides of the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
- compare local changes vs upstream changes semantically, not just textually
- classify the conflict into one of these categories:
  - **Duplicate solution**: both sides implemented the same fix/feature differently → pick the upstream version (maintainer's canonical solution) unless local version has meaningful additions
  - **Complementary changes**: both sides changed different aspects of the same region → can be merged automatically by combining both
  - **True conflict**: genuinely incompatible changes → flag for human review with clear explanation
  - **Cosmetic conflict**: whitespace, import ordering, formatting differences → auto-resolve by preferring upstream style

#### Step 3: Attempt resolution

- For **duplicate solutions**: check if local version adds anything upstream doesn't cover. If not, accept upstream. If local has extras, keep local additions on top of upstream base.
- For **complementary changes**: apply both changes, validate syntax post-merge.
- For **cosmetic conflicts**: accept upstream formatting.
- For **true conflicts**: leave conflict markers, but annotate the report with:
  - what each side intended
  - which local commits introduced the local change
  - which upstream commits introduced the upstream change
  - a recommended resolution with reasoning

#### Step 4: Post-resolution validation

- After auto-resolving, run any available linters or type checks to catch broken merges
- If validation fails, revert to conflict state and flag for manual review
- Log every auto-resolution decision for the report

#### Duplicate logic detection (proactive, during status phase)

Before sync even starts, the `status` workflow should:

- compare local commits against upstream commits for similar changes (same files, similar diff patterns)
- flag cases where the plugin maintainer may have already solved the same problem the fork solved locally
- recommend dropping local commits that are now redundant with upstream
- use `git log --oneline --diff-filter=M` on both sides to find overlapping file modifications
- generate a "redundancy report" showing local commits that may be superseded by upstream

### Verification

- Duplicate solution conflicts are auto-resolved correctly without losing unique local additions
- Complementary changes merge cleanly and pass syntax validation
- True conflicts are clearly annotated with both sides' intent and recommended resolution
- Redundancy report accurately identifies local commits superseded by upstream
- Simulated conflict leaves repo in recoverable state when auto-resolution fails
- Backup branch can restore pre-sync commit graph
- Reports always include recovery commands when any resolution step fails

---

## Integration Points

## `git-master`

Use `git-master` as a reference skill, not as a runtime dependency.

- Reuse its conventions for branch safety, rebase caution, and clean reporting
- Mirror its push guidance: prefer `--force-with-lease`, never bare `--force`
- Borrow its idea of explicit strategy reporting: merge vs rebase vs no-op
- Do not require loading `git-master` just to run `fork-sync`; the new skill must remain self-sufficient

## `fork-terminal`

Use this for multi-repo operations when implementation work begins.

- Parallelize read-only operations across many repos:
  - scan metadata
  - fetch status
  - generate fleet reports
- Keep sync execution serialized per repo unless the user explicitly requests batch automation
- Use background execution for long-running fleet scans

## `python-run`

- Use `uv run ~/.opencode/skills/fork-sync/tools/<script>.py`
- Keep scripts directly executable via `uv run` without extra packaging
- Prefer JSON output flags so agents can chain scripts deterministically

---

## Edge Cases To Design For

### Repo topology

- repo has `origin` but no `upstream`
- repo is a fork on GitHub but local remotes are incomplete
- upstream default branch is `dev`, not `main`
- repo is on a feature branch while sync target is default branch
- worktree is a git worktree, not a standalone clone

### State problems

- dirty tracked changes
- untracked files only
- stash already present
- merge in progress
- rebase in progress
- detached HEAD
- missing local default branch

### Network and auth

- `gh` unauthenticated or unavailable
- `git fetch` fails due to auth or network
- upstream remote URL is stale or invalid

### Sync complexity

- fork is only behind upstream: safe merge path
- fork is ahead and behind: preserve local commits, recommend merge by default
- rebase succeeds but requires force-with-lease push
- conflict during merge
- conflict during rebase
- fast-forward possible via `gh repo sync`

### Reporting

- partial fleet failures should not hide successful repos
- non-fork repos should be reported as skipped, not failed
- no-op sync should still generate a summary

---

## Implementation Phases

## Phase 1 — Scaffold the skill structure

### Deliverables

- Create `~/.opencode/skills/fork-sync/`
- Add `SKILL.md`, `tools/`, `workflows/`, `references/`, `templates/`
- Define YAML frontmatter and router-style entrypoints
- Define the shared JSON schema in docs or `common.py`

### Verification

- Paths exist in the expected skill directory
- `SKILL.md` is under 500 lines and clearly routes `scan/status/sync/report`
- Every planned workflow has a matching file

## Phase 2 — Build discovery and status tooling

### Deliverables

- Implement `tools/common.py`, `tools/scan.py`, `tools/status.py`
- Add git-only detection first, then enrich with `gh` when available
- Support machine-readable output and concise human output

### Verification

- `uv run ~/.opencode/skills/fork-sync/tools/scan.py --help`
- `uv run ~/.opencode/skills/fork-sync/tools/status.py --help`
- Manual tests against a directory containing at least:
  - one healthy fork
  - one non-fork repo
  - one repo with no upstream remote

## Phase 3 — Implement guarded sync flow

### Deliverables

- Implement `tools/sync.py`
- Add merge default and rebase optional path
- Add backup branch and optional stash handling
- Add conflict detection and rollback messaging

### Verification

- Dry-run mode shows intended commands without mutation
- Merge path works on a throwaway test fork
- Rebase path works on a throwaway test fork
- Conflict simulation leaves repo recoverable and reports exact next actions

## Phase 4 — Reporting and templates

### Deliverables

- Implement `tools/report.py`
- Add `templates/repo-report.md` and `templates/fleet-report.md`
- Ensure all other tools can emit JSON consumable by `report.py`

### Verification

- A successful sync generates a readable report
- A failed sync generates a readable report with recovery steps
- Fleet status report highlights ready, blocked, and skipped repos separately

## Phase 5 — Agent workflow polish

### Deliverables

- Flesh out `workflows/scan.md`, `status.md`, `sync.md`, `report.md`
- Add references for safety rules and strategy choice
- Document when to use merge vs rebase vs `gh repo sync`

### Verification

- A fresh OpenCode session can read `SKILL.md` and route correctly
- Workflow docs reference actual tool paths and commands
- No workflow suggests unsafe defaults

## Phase 6 — Real-world validation

### Deliverables

- Validate against the user's fork setup, including `~/Projects/Claude-fork` when appropriate
- Run scan, status, dry-run sync, and report end-to-end
- Fix rough edges found in real repos

### Verification

- Discovery identifies real fork metadata correctly
- Status output matches manual git inspection
- Dry-run sync decisions align with expected merge/rebase policy
- Reports are clear enough to act on without re-running git commands manually

---

## Suggested Execution Order For A Follow-up Agent

1. Create the skill scaffold and `SKILL.md`
2. Implement shared helpers in `common.py`
3. Implement `scan.py`
4. Implement `status.py`
5. Add workflow and reference docs for read-only operations
6. Implement `sync.py` with `--dry-run` first
7. Implement `report.py`
8. Validate on throwaway repos before touching real forks
9. Validate on actual user forks

This order keeps read-only capabilities usable early and delays risky write operations until the safety layer is solid.

---

## Acceptance Criteria

- The skill can classify repos as fork, non-fork, or incomplete-metadata
- The skill can report ahead/behind counts against upstream accurately
- The skill refuses unsafe sync attempts with actionable explanations
- Merge sync works as the default safe path
- Rebase sync is available with explicit warnings and force-with-lease guidance
- Conflict cases are intelligently classified: duplicates auto-resolved, true conflicts flagged with annotated reasoning
- Redundancy detection identifies local commits already solved by upstream maintainer
- Reports are useful for both single-repo and fleet views
- All scripts are runnable via `uv run` from Linux without extra setup

---

## Implementation Notes For The Agent

- Prefer Python stdlib plus subprocess; avoid extra dependencies unless truly necessary
- Emit JSON from scripts by default or behind `--json`
- Keep agent-facing prose in `SKILL.md` and workflow docs, not buried in scripts
- Use `gh` as optional enrichment, not a hard dependency for base functionality
- Treat `origin` and `upstream` naming as conventional but be ready to infer parent repo metadata when only `origin` exists
- Keep the first version conservative: no auto-push, no auto-cleanup of backup branches/stashes
- Auto-conflict-resolution IS enabled but only for high-confidence cases (duplicate solutions, complementary changes, cosmetic diffs); true conflicts always stop for human review
- Duplicate logic detection should compare diffs semantically — same function modified, same bug fixed, same feature added — not just file-name overlap

---

## Minimum Test Matrix For Implementation

- clean fork, behind only, merge sync succeeds
- clean fork, ahead and behind, merge sync succeeds
- clean fork, ahead and behind, rebase sync succeeds
- dirty fork with auto-stash disabled, sync blocked
- dirty fork with auto-stash enabled, stash created and restored
- fork missing upstream, sync blocked with remediation guidance
- non-fork repo, scan/status reports skipped
- merge conflict — duplicate solution detected and auto-resolved
- merge conflict — complementary changes merged and validated
- merge conflict — true conflict flagged with annotated report
- merge conflict — auto-resolution fails validation, reverted to conflict state
- rebase conflict — same classification and resolution logic applies per-commit
- redundancy report correctly identifies local commits superseded by upstream
- `gh` unavailable, git-only fallback still works

---

## Final Deliverable Expectation

When implemented, the skill should feel like an intelligent git operator specialized for fork maintenance: discoverable, transparent, smart about conflict resolution and duplicate detection, resumable after failure, and optimized for maintaining custom OpenCode plugin forks over time.
