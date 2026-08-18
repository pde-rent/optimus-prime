<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="../../assets/brand/prime-butterfly.svg">
      <img alt="Prime Intellect butterfly mark" src="../../assets/brand/prime-butterfly-black.svg" width="96">
    </picture>
  </a>
</p>

<h1 align="center">Prime Agent CLI</h1>

<p align="center">
  RLM-native terminal coding and research harness.
</p>

Prime Agent began as a hard fork of [pi-mono](https://github.com/badlogic/pi-mono), but it is now developed and distributed independently. This workspace retains inherited `@earendil-works/pi-*` source package identifiers, the `pi` package manifest key, and a source-package `pi` bin entry for internal compatibility. Public releases are currently versioned tarball artifacts installed by the scripts below; release packaging rewrites the application package and command to `prime-agent`. Do not use the inherited npm package as the Prime Agent install path.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [MCP Integrations](#mcp-integrations)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Prime Agent Packages](#prime-agent-packages)
- [Programmatic Usage](#programmatic-usage)
- [Upstream](#upstream)
- [CLI Reference](#cli-reference)

## Quick Start

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

To install the beta built from the latest commit on `main`:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh -s -- beta
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

Or use your existing subscription:

```bash
prime-agent
/login  # Then select provider
```

Then just talk to Prime Agent. By default, Prime Agent gives the model one tool, named `ipython`: a persistent Bun JavaScript/TypeScript REPL. The model uses it to read files, run commands, edit code, and inspect data. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [Prime Agent packages](#prime-agent-packages).

The tool name is kept for compatibility with existing sessions and `--tools` filters; there is no IPython, Jupyter, or Python involved. Cells are JavaScript/TypeScript with top-level `await`, the last expression is echoed as the result, and declarations persist across cells. A cell whose first line is `%%bash` runs as a shell command instead. The REPL starts on first use and needs no setup, but [Bun](https://bun.sh) must be on your `PATH`.

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

## Providers & Models

For each built-in provider, Prime Agent maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- OpenAI
- Prime Inference
- Azure OpenAI
- DeepSeek
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.prime/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows a compact brand and runtime summary; use `--verbose` to list loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type
- **Footer** - Empty by default; use `/usage` for token, cost, and context details

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/effort` | Set reasoning/thinking level |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume [id\|path]` | Open the agents view, or resume a session directly |
| `/new`, `/clear` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages) |
| `/traces [status\|on\|off\|preview\|upload-current\|upload-all\|login]` | Preview traces, run one-shot current/all uploads, and manage automatic sharing (`upload` aliases `upload-current`) |
| `/usage` | Show token, cost, and context usage |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/btw <question>`, `/side <question>` | Ask an inline side question without adding it to the session; replies continue the side conversation, esc returns |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Prime Agent |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.prime/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Interrupt active work, or show the exit hint when idle |
| Ctrl+C twice | Exit while the exit hint is visible |
| Escape | Clear the input without interrupting active work |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Ctrl+C** interrupts active work; queued messages are kept and resume after your next submit or edit
- **Escape** clears the input without interrupting active work
- **Alt+Up / Alt+Down** browse queued messages individually and return to the editor draft
- While browsing, **Enter** applies the edit as steering input and **Alt+Enter** applies it as a follow-up; submitting an empty edit deletes the item
- **Ctrl+Alt+Up / Ctrl+Alt+Down** move the selected item earlier or later within its queue

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so Prime Agent can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save as flat JSONL files under `~/.prime/agent/sessions/`. Each session header records its working directory, which the searchable session view uses to identify and open saved sessions.

```bash
prime-agent -c                  # Continue most recent session
prime-agent -r [path|id]        # Browse past sessions or resume one directly
prime-agent --no-session        # Ephemeral mode (don't save)
prime-agent --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--resume <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.prime/agent/settings.json` | Global (all projects) |
| `.prime/agent/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Update checks

Prime Agent stable builds fetch `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json` to check whether a newer version exists. Beta builds fetch `beta.json` and remain on the beta channel. Override the base URL with `PRIME_AGENT_DOWNLOAD_BASE_URL`. Disable version checks with `PI_SKIP_VERSION_CHECK=1`.

Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

## Context Files

Prime Agent loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.prime/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.prime/agent/SYSTEM.md` (project) or `~/.prime/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.prime/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.prime/agent/prompts/`, `.prime/agent/prompts/`, or a [Prime Agent package](#prime-agent-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). At startup, Prime Agent gives the model each visible skill's name, type, description, and location. The full `SKILL.md` stays out of context until the model inspects it with `ipython` or you explicitly invoke `/skill:name`.

```markdown
<!-- ~/.prime/agent/skills/my-skill/SKILL.md -->
---
name: my-skill
description: Use this skill when the user asks about X.
---

# My Skill

## Steps
1. Do this
2. Then that
```

Skills can also be JS-backed. A JS skill is a normal skill directory with `SKILL.md` plus a `skill.js` ESM module at its root that exports a `createSkill(ctx)` factory. Prime Agent preloads it into the persistent REPL and binds whatever the factory returns under the skill's name with hyphens replaced by underscores, so the model can call it directly:

```js
// ~/.prime/agent/skills/word-count/skill.js
export default function createSkill(ctx) {
  return {
    /** Count words in text. @param {string} text @returns {Promise<number>} */
    async run(text) {
      return text.split(/\s+/).filter(Boolean).length;
    },
  };
}
```

```js
await word_count.run("some text to analyze");   // in the REPL
```

There is no install step — editing `skill.js` takes effect on the next REPL start. Skills do not ship CLI entry points, so there is no `<skill> --help` shell command; a skill is called through its REPL binding.

Place in `~/.prime/agent/skills/`, `~/.agents/skills/`, `.prime/agent/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [Prime Agent package](#prime-agent-packages) to share with others. See [docs/skills.md](docs/skills.md).

Prime Agent ships with a built-in `websearch` skill (web search plus a page reader). It loads by default and supports two backends: a **self-hosted [SearXNG](https://docs.searxng.org) instance** (recommended — free, keyless, private: `docker run -d -p 8888:8080 searxng/searxng`, then set `SEARXNG_URL`, `search.formats: [html, json]`, and `server.limiter: false`), or the [Serper](https://serper.dev) API (run `/login`, switch to **MCP Connections**, and choose "Serper (web search)"). Public SearXNG instances are deliberately not used: they block programmatic clients by design. Disable the skill with `bundledSkills.websearch: false`, or override it with your own `websearch` skill in any location above. See [docs/skills.md#built-in-skills](docs/skills.md#built-in-skills).

### MCP Integrations

Connect external services (Linear, Notion, …) over the [Model Context Protocol](https://modelcontextprotocol.io). Consistent with the single-tool design, MCP is **not** exposed as new agent tools — each integration is a JS skill bound as a REPL global that the model calls directly:

```js
await linear.list_tools();                              // tools auto-discovered from the server
await linear.list_issues({ team: "Engineering" });      // call one by name
await notion.call_tool("notion-search", { query: "roadmap" });  // names that aren't valid identifiers
```

Built-in integrations for Linear and Notion ship disabled. **Logging in enables them**: open `/login`, switch to **MCP Connections**, pick the integration, and complete OAuth in the browser. The integration's skill then becomes visible and is preloaded into the REPL. `/mcp` opens the same tab, while its subcommands support direct management:

```
/mcp                 list integrations and connection status
/mcp login <name>    connect via OAuth (browser)
/mcp logout <name>   disconnect
```

Credentials are stored once in `~/.prime/agent/auth.json` (under `mcp:<name>`); the skill reads them directly from the REPL and asks the host to refresh expired tokens. Enablement is derived from whether valid credentials exist, so there is no separate on/off switch.

**Add your own server.** Declare it under `mcpServers` in settings, then ship a tiny JS skill that calls `createMcpSkill`:

```jsonc
// ~/.prime/agent/settings.json
{
  "mcpServers": {
    "acme": { "type": "http", "url": "https://mcp.acme.com/mcp", "oauth": true }
  }
}
```

```js
// ~/.prime/agent/skills/acme/skill.js
import { createMcpSkill } from "./mcp-client.js";

export default function createSkill(ctx) {
  return createMcpSkill({ server: "acme", url: "https://mcp.acme.com/mcp" }, ctx);
}
```

Copy `mcp-client.js` next to your `skill.js` (it is duplicated per skill directory on purpose, since skills load by absolute path from independent roots). It speaks MCP Streamable HTTP over `fetch`, injects the bearer token from `auth.json`, asks the host to refresh expired tokens, and dispatches the server's discovered tools as async methods. Use `await acme.call_tool("name", {...})` for tools whose names aren't valid JavaScript identifiers, or pass `bearerTokenEnv` instead of using OAuth.

See [docs/mcp-integrations.md](docs/mcp-integrations.md) for the full authoring guide (skill layout, auth options, the `createMcpSkill` API, and caveats).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend Prime Agent with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. Prime Agent waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Additional orchestration workflows and plan modes
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make Prime Agent look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.prime/agent/extensions/`, `.prime/agent/extensions/`, or a [Prime Agent package](#prime-agent-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and Prime Agent immediately applies changes.

Place in `~/.prime/agent/themes/`, `.prime/agent/themes/`, or a [Prime Agent package](#prime-agent-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Prime Agent Packages

Bundle and share extensions, skills, prompts, and themes via npm or git.

> **Security:** Prime Agent packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
prime-agent package install npm:@foo/prime-agent-tools
prime-agent package install npm:@foo/prime-agent-tools@1.2.3  # pinned version
prime-agent package install git:github.com/user/repo
prime-agent package install git:github.com/user/repo@v1       # tag or commit
prime-agent package install git:git@github.com:user/repo
prime-agent package install https://github.com/user/repo
prime-agent package install ssh://git@github.com/user/repo
prime-agent package remove npm:@foo/prime-agent-tools
prime-agent package list
prime-agent package update                                  # update packages, except pinned versions
prime-agent package update npm:@foo/prime-agent-tools       # update one package
prime-agent update                                          # update Prime Agent
prime-agent update --force                                  # reinstall Prime Agent even if current
prime-agent config                                          # enable/disable package resources
```

Packages install to `~/.prime/agent/git/` (git) or the global package root. Use `--local` for project-local installs (`.prime/agent/git/`, `.prime/agent/npm/`). Git packages install dependencies with `bun install --production` by default, so runtime deps must be listed under `dependencies`. To install through a different package manager or a wrapper, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding the inherited `pi` manifest key to `package.json`:

```json
{
  "name": "my-prime-agent-package",
  "keywords": ["prime-agent-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, Prime Agent auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "prime-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
prime-agent --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

## Upstream

Prime Agent is forked from [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner and keeps MIT attribution in the root license.

The package architecture, extension model, and source package names still reflect that upstream lineage while the distributed command and release artifacts are branded for Prime Agent.

## CLI Reference

```bash
prime-agent [options] [@files...] [messages...]
```

Run `prime-agent help` for the command list and `prime-agent help <command>` for details.

### Agent Commands

```bash
prime-agent agents                         # Search running, idle, and inactive sessions
prime-agent list [--all]                   # List active or saved agents
prime-agent attach <agent>                 # Attach the interactive UI
prime-agent stop <agent>                   # Stop one agent
prime-agent rename <agent> <name>          # Rename an agent
prime-agent send <agent> <message>         # Send an agent-to-agent message
prime-agent status                         # Show background service status
prime-agent doctor [--fix]                 # Inspect or safely clean up background services
prime-agent shutdown [--force]             # Stop every agent, worker, and background service
```

`shutdown` asks for confirmation. `shutdown --force` skips confirmation and kills unresponsive workers and their tracked child processes.

### Scheduled Prompts

```bash
prime-agent schedule list [--all] [agent]
prime-agent schedule add <agent> <schedule> -- <message>
prime-agent schedule cancel <job-id>
```

Schedules run prompts later or repeatedly. A schedule can be a supported one-time expression such as `in 5m` or a cron expression.

### Package and Update Commands

Packages bundle capabilities such as extensions, skills, prompts, and themes.

```bash
prime-agent package install <source> [--local]
prime-agent package remove <source> [--local]
prime-agent package list
prime-agent package update [source]
prime-agent update [--force]                   # Update Prime Agent itself
prime-agent config                             # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |

In print mode, Prime Agent also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | prime-agent -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |

Use `prime-agent model list [search]` to list available models.

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume [path\|id]` | Open the searchable session view, or resume a specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

Use `prime-agent session export <file> [output]` to export a saved session to HTML.

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `ipython` (the persistent Bun JS/TS REPL; the name is historical)

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Autonomous Options

Autonomous mode is disabled by default. `--autonomous` or any of its sub-options enables host-managed continuations for unattended work.

| Option | Description |
|--------|-------------|
| `--autonomous` | Continue until gates pass or a limit prevents another continuation |
| `--autonomous-gate <command>` | Add a repeatable shell command that must pass before completion |
| `--autonomous-gate-retries <n>` | Positive per-gate retry limit; default `3` |
| `--autonomous-gate-timeout-ms <n>` | Positive per-gate timeout in milliseconds; default `300000` |
| `--autonomous-max-continuations <n>` | Positive host follow-up limit; default `3` |
| `--autonomous-max-turns <n>` | Positive assistant-turn limit; default `12` |
| `--autonomous-max-tokens <n>` | Positive token limit; default `80000` |
| `--autonomous-timeout-ms <n>` | Positive wall-clock limit in milliseconds; default `1800000` |

Gates run before the continuation, turn, token, and wall-clock limits are evaluated; every configured gate must pass for autonomous completion. See the [usage guide](docs/usage.md#autonomous-options) for validation rules, retry behavior, and detailed limit interactions.

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
prime-agent @prompt.md "Answer this"
prime-agent -p @screenshot.png "What's in this image?"
prime-agent @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
prime-agent "List all .ts files in src/"

# Non-interactive
prime-agent -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | prime-agent -p "Summarize this text"

# Different model
prime-agent --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
prime-agent --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
prime-agent --model sonnet:high "Solve this complex problem"

# Limit model cycling
prime-agent --models "claude-*,gpt-4o"

# Restrict to the built-in REPL tool
prime-agent --tools ipython -p "Review the code"

# High thinking level
prime-agent --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PRIME_AGENT_CODING_AGENT_DIR` | Override config directory (default: `~/.prime/agent`) |
| `PRIME_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `PRIME_AGENT_CODING_AGENT_SESSION_DIR` | Legacy alias for `PRIME_AGENT_SESSION_DIR` |
| `PI_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `PI_OFFLINE` | Disable startup network operations, including update checks and package update checks |
| `PI_SKIP_VERSION_CHECK` | Skip the Prime Agent version update check at startup. This prevents the release manifest request |
| `PRIME_AGENT_TELEMETRY` | Override pseudonymous aggregate usage analytics with `1`/`true`/`yes` or `0`/`false`/`no` |
| `PRIME_AGENT_TELEMETRY_ENDPOINT` | Override the aggregate analytics ingestion endpoint |
| `DO_NOT_TRACK` | Disable aggregate usage analytics when set to `1`/`true`/`yes` |
| `PRIME_AGENT_DOWNLOAD_BASE_URL` | Override the Prime Agent release manifest and tarball base URL |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `PRIME_API_KEY` | Prime Inference API key; also used for trace sharing if it has `agent_traces` scope |
| `PRIME_AGENT_TRACES_API_KEY` | Prime API key used only for opt-in trace sharing |
| `PRIME_AGENT_TRACES_BASE_URL` | Override the Prime Agent trace upload API base URL |
| `PRIME_AGENT_REPL_SKILLS` | **Host-set, not user-set.** JSON list of the JS skills the REPL child preloads (`{name, global, entry}`). Prime Agent writes it when spawning the REPL; setting it yourself is unsupported |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

The remaining `PI_*` variables in this table are compatibility names still read by the current runtime. They do not change the application name, command, or default `~/.prime/agent` configuration path.

## Contributing & Development

See [docs/development.md](docs/development.md) for setup and debugging.

## License

MIT

## See Also

- [Prime Agent AI](../ai): Core LLM toolkit
- [Prime Agent Core](../agent): Agent framework
- [Prime Agent TUI](../tui): Terminal UI components
