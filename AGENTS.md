- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## Build & Install Pipeline

When asked to build, install, or test the fork globally, follow this pipeline exactly.

### Prerequisites

- Working directory: repo root (e.g. `/home/yevhenii/Projects/opencode-fork`)
- Bun installed and available
- The compiled binary installs to `~/.opencode/bin/opencode`

### Step 1: Build (single platform)

```bash
cd packages/opencode && bun run build -- --single
```

Output binary: `packages/opencode/dist/opencode-linux-x64/bin/opencode` (path varies by OS/arch).

### Step 2: Backup current global version

Before replacing, always backup with a git-hash-stamped name:

```bash
# Get current version's git hash for the backup name
HASH=$(~/.opencode/bin/opencode --version 2>/dev/null | grep -oP '\+\K[a-f0-9]+' || echo "unknown")
cp ~/.opencode/bin/opencode ~/.opencode/bin/opencode.backup-${HASH}
```

**Backup naming convention**: `opencode.backup-<git-short-hash>` (e.g. `opencode.backup-602be7c04`).

After backup, prune old backups — keep only the 3 most recent:

```bash
ls -t ~/.opencode/bin/opencode.backup-* 2>/dev/null | tail -n +4 | xargs rm -f
```

### Step 3: Install globally

```bash
cp packages/opencode/dist/opencode-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/')/bin/opencode ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
```

Or use the install script:

```bash
./install --binary packages/opencode/dist/opencode-linux-x64/bin/opencode
```

### Step 4: Verify

```bash
~/.opencode/bin/opencode --version
```

Confirm the version string includes the expected fork hash (e.g. `1.2.27-fork+<new-hash>`).

### Step 5: Test

```bash
cd packages/opencode && bun test --timeout 30000
```

Also run typecheck:

```bash
cd packages/opencode && bun typecheck
```

### Rollback

If the new build is broken, restore from backup:

```bash
LATEST_BACKUP=$(ls -t ~/.opencode/bin/opencode.backup-* 2>/dev/null | head -1)
cp "$LATEST_BACKUP" ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
```

### One-liner (full pipeline)

```bash
cd packages/opencode \
  && bun run build -- --single \
  && HASH=$(~/.opencode/bin/opencode --version 2>/dev/null | grep -oP '\+\K[a-f0-9]+' || echo "unknown") \
  && cp ~/.opencode/bin/opencode ~/.opencode/bin/opencode.backup-${HASH} \
  && ls -t ~/.opencode/bin/opencode.backup-* 2>/dev/null | tail -n +4 | xargs rm -f \
  && cp dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode \
  && chmod 755 ~/.opencode/bin/opencode \
  && ~/.opencode/bin/opencode --version
```

### Important notes

- **Dev mode** (`bun run dev` from repo root) runs source directly — no build needed. Use for quick iteration.
- **Compiled binary** testing is needed to verify build output, bundled migrations, embedded assets.
- The bun global wrapper at `~/.bun/bin/opencode` resolves to `packages/opencode/bin/opencode` which also checks `packages/opencode/bin/.opencode` as a cached binary.
- Never leave `~/.opencode/bin/opencode` in a broken state — always backup first.
- See `.opencode/plans/build-install-pipeline.md` for extended reference.

## Plugin Ecosystem State

Last audited: 2026-03-27

### Marketplaces (`~/.claude/plugins/known_marketplaces.json`)

| Name                    | Type            | Source                                         |
| ----------------------- | --------------- | ---------------------------------------------- |
| claude-plugins-official | GitHub          | `anthropics/claude-plugins-official`           |
| superpowers-marketplace | GitHub          | `obra/superpowers-marketplace`                 |
| cortex-dev              | Local directory | `/mnt/workdrive/Projects/Python/cortex-plugin` |
| unreal-bridge-dev       | Local directory | (disabled)                                     |

### npm Plugins (`opencode.json` → `plugin[]`)

| Package                                 | Source                                                          | Notes                                                             |
| --------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| oh-my-opencode                          | npm `3.14.0`                                                    | Core orchestration plugin. GitHub: `code-yeongyu/oh-my-openagent` |
| opencode-gemini-auth@latest             | npm                                                             | Google Gemini auth                                                |
| @kaladrius2trip/opencode-anthropic-auth | `file:/home/yevhenii/Projects/opencode-anthropic-auth`          | Custom Anthropic OAuth                                            |
| cc-safety-net                           | `file:/home/yevhenii/Projects/claude-code-safety-net`           | Safety guardrails                                                 |
| @tarquinen/opencode-dcp                 | `file:/home/yevhenii/Projects/opencode-dynamic-context-pruning` | Dynamic context pruning                                           |
| @plannotator/opencode                   | `file:/home/yevhenii/Projects/plannotator/apps/opencode-plugin` | Plan annotation UI                                                |
| opentmux                                | `file:/home/yevhenii/Projects/opentmux`                         | Tmux integration                                                  |

### Marketplace Plugins — Superpowers (`obra/superpowers-marketplace`)

| Plugin                                 | Version | Commit     | GitHub Source                | Status                                                                            |
| -------------------------------------- | ------- | ---------- | ---------------------------- | --------------------------------------------------------------------------------- |
| superpowers                            | v5.0.5  | `8ea39819` | `obra/superpowers`           | Up to date (note: package.json says 5.0.4, git tag is v5.0.5 — upstream mismatch) |
| double-shot-latte                      | v1.2.0  | `dfe75679` | `obra/double-shot-latte`     | Up to date                                                                        |
| elements-of-style                      | v1.0.0  | `6099c505` | `obra/the-elements-of-style` | Up to date                                                                        |
| episodic-memory                        | v1.0.15 | `6feaa5bd` | `obra/episodic-memory`       | Up to date                                                                        |
| superpowers-chrome                     | v1.8.0  | `70b2c6cb` | `obra/superpowers-chrome`    | Up to date                                                                        |
| superpowers-developing-for-claude-code | v0.3.1  | `74afe935` | obra                         | Up to date                                                                        |
| superpowers-lab                        | v0.4.0  | `59389b15` | `obra/superpowers-lab`       | Up to date                                                                        |

### Marketplace Plugins — Official (`anthropics/claude-plugins-official`)

All at commit `b10b583d`. Up to date.

Installed: clangd-lsp, commit-commands, context7, csharp-lsp, lua-lsp, pyright-lsp, rust-analyzer-lsp, code-review, hookify, claude-md-management, claude-code-setup, frontend-design, feature-dev, code-simplifier, ralph-loop, typescript-lsp, plugin-dev, learning-output-style

| Plugin             | Version | Commit     | GitHub Source        | Status     |
| ------------------ | ------- | ---------- | -------------------- | ---------- |
| huggingface-skills | v1.0.1  | `ff289081` | `huggingface/skills` | Up to date |

### Marketplace Plugins — Local

| Plugin | Version | Commit     | Location                                       | Status     |
| ------ | ------- | ---------- | ---------------------------------------------- | ---------- |
| cortex | v0.2.6  | `6d4655d7` | `/mnt/workdrive/Projects/Python/cortex-plugin` | Up to date |

### Patches (bun)

1. **`@openrouter/ai-sdk-provider@1.5.4`** — Adds `providerMetadata.openrouter.reasoning_details` to `reasoning-end` events in streaming
2. **`@standard-community/standard-openapi@0.2.9`** — Handles external `$ref` URLs in OpenAPI schema conversion

### oh-my-opencode Config (`~/.config/opencode/oh-my-opencode.json`)

Schema: `https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-opencode.schema.json`

**Agents:**
| Agent | Model | Variant |
|-------|-------|---------|
| sisyphus | anthropic/claude-opus-4-6 | max |
| hephaestus | openai/gpt-5.4 | medium |
| oracle | openai/gpt-5.4 | high |
| explore | github-copilot/grok-code-fast-1 | — |
| multimodal-looker | google/gemini-3-flash-preview | medium |
| prometheus | anthropic/claude-opus-4-6 | max |
| metis | anthropic/claude-opus-4-6 | max |
| momus | openai/gpt-5.4 | medium |
| atlas | anthropic/claude-sonnet-4-6 | — |
| sisyphus-junior | anthropic/claude-sonnet-4-6 | — |
| librarian | google/gemini-3-flash-preview | — |

**Categories:**
| Category | Model | Variant |
|----------|-------|---------|
| visual-engineering | github-copilot/gemini-3.1-pro-preview | high |
| ultrabrain | openai/gpt-5.4 | xhigh |
| deep | openai/gpt-5.4 | medium |
| artistry | github-copilot/gemini-3.1-pro-preview | high |
| quick | openai/gpt-5.4-mini | — |
| unspecified-low | anthropic/claude-sonnet-4-6 | — |
| unspecified-high | anthropic/claude-opus-4-6 | max |
| writing | github-copilot/gemini-3-flash-preview | — |

### Custom Skills (non-plugin)

**`~/.claude/skills/`**: bulk-files, cortex, create-hooks, create-meta-prompts, create-plans, create-slash-commands, create-subagents, developer, fork-terminal, json-canvas, obsidian-bases, obsidian-markdown, pattern-editor, python-run, skill-toolkit, smart-parser, tts-speak, ue-worktree

**`~/.opencode/skills/`**: fork-sync, ue-worktree

### Connected Providers

openai, github-copilot, google, anthropic, opencode, google-vertex, google-vertex-anthropic, ollama

### Update Checklist (for next audit)

```bash
# Check oh-my-opencode
bun outdated oh-my-opencode --cwd ~/.cache/opencode/

# Check marketplace plugins (compare installed commit vs latest)
# superpowers marketplace
gh api repos/obra/superpowers/commits/main --jq '.sha[:8]'
gh api repos/obra/double-shot-latte/commits/main --jq '.sha[:8]'
gh api repos/obra/superpowers-chrome/commits/main --jq '.sha[:8]'

# official plugins
gh api repos/anthropics/claude-plugins-official/commits/main --jq '.sha[:8]'

# huggingface
gh api repos/huggingface/skills/commits/main --jq '.sha[:8]'
```
