# WorkOS (WOS)

WorkOS is a local-first desktop AI agent built on Electron, React, and SQLite. It runs a shared agent kernel that powers five integrated product surfaces: Chat, Apps, Automations, Meetings, and Projects. All data stays on your machine. There is no cloud backend.

## What WOS does

| Surface | Description |
|---|---|
| **Chat** | Conversational agent with tool use, planning mode, and subagents |
| **Apps** | First-class integrations for Slack, GitHub, Jira, and Google Workspace |
| **Automations** | Headless agent runs triggered by schedule, internal hooks, or webhooks |
| **Meetings** | Live recording and upload pipeline with transcription and AI analysis |
| **Projects** | Resource aggregator that links app data into a unified activity feed |

WOS is extensible through Skills (Markdown knowledge packs), Rules (Cursor-compatible), MCP servers (stdio, HTTP, SSE), and drop-in JavaScript plugins, none of which require a code rebuild.

---

## Prerequisites

- **Node.js 20+** (tested on v24)
- **macOS** (live meeting transcription uses the Apple Speech API; other surfaces work on Linux and Windows)
- An API key from **Anthropic** or **OpenAI** (or any OpenAI-compatible provider)

---

## Quick Start

```bash
git clone <repo-url>
cd wos
npm install
npm run dev
```

This launches the Electron app with hot module replacement. On first launch, go to **Settings > API Keys** and add your Anthropic or OpenAI key. Models are fetched from the provider's `/models` endpoint and cached locally.

---

## Available Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the app with hot reload |
| `npm run lint` | Type-check with `tsc --noEmit` |
| `npm test` | Run unit tests with Vitest |
| `npm run e2e:build` | Package the app for E2E testing (run once before E2E tests) |
| `npm run e2e:smoke` | Boot, window, and database sanity check |
| `npm run e2e:live` | Open Playwright Inspector for interactive testing |
| `npm run e2e:trace` | Record video and trace output to `e2e/scratch/` |
| `npm run e2e:full` | Full integration test suite |

---

## User Configuration (`~/.wos/`)

WOS keeps all user-editable configuration under `~/.wos/`. This directory is separate from the Electron `userData` directory, which holds the SQLite database, logs, and encrypted credentials.

```
~/.wos/
├── apps/
│   └── <appId>/config.json         # Per-app metadata (enabled state, scopes)
├── mcp.json                         # MCP server list (mirrors the database)
├── plugins/
│   └── <id>/
│       ├── wos-plugin.json          # Plugin manifest
│       └── index.js                 # CommonJS module
├── skills/
│   └── <skillId>/
│       ├── SKILL.md                 # Frontmatter + Markdown body
│       └── resources/               # Optional files the skill references
└── rules/
    └── <ruleId>.md                  # User-level rules with frontmatter
```

---

## Skills

Skills are Markdown files that teach the agent domain-specific workflows. The agent loads an index of all skills into its system prompt and fetches the full body of a skill when it decides the skill is relevant.

Create a skill at `~/.wos/skills/<id>/SKILL.md`:

```markdown
---
name: Create PowerPoint decks
description: Generate editable .pptx slide decks from an outline.
triggers:
  - pptx
  - slide deck
  - presentation
---

# Create PowerPoint decks

Step 1: Use python-pptx to create a presentation object...
```

Trigger keywords are matched by the intent engine before each turn to determine which tools and skills are relevant. Rescan skills at any time from **Settings > Skills > Rescan**.

---

## Rules

Rules are Markdown files that shape agent behavior. They are loaded from two locations and merged in order:

1. User rules: `~/.wos/rules/*.md`
2. Workspace rules: `<workspacePath>/.cursor/rules/*.mdc` (Cursor-compatible)

Supported frontmatter fields:

```yaml
---
name: Always prefer TypeScript
description: Use TypeScript over JavaScript in all new files.
alwaysApply: true
globs: ["**/*.ts", "**/*.tsx"]
---
```

- `alwaysApply: true` rules are inlined into every system prompt.
- Glob-scoped rules surface a one-line hint; the agent fetches the full body via `ReadRule(id)` when needed.

---

## MCP Servers

Add an MCP server from **Apps > Marketplace > MCP server** or the **Installed MCP** tab. Three transports are supported:

- `stdio` - spawn a local process with `command`, `args`, and `env`
- `http` - JSON-RPC over HTTP
- `sse` - JSON-RPC over Server-Sent Events

Tool names are automatically namespaced as `mcp__<serverId>__<toolName>`. The server list is mirrored to `~/.wos/mcp.json` for portability.

---

## Plugins

Drop-in JavaScript plugins live under `~/.wos/plugins/<id>/` and are hot-reloaded by a file watcher.

**Manifest (`wos-plugin.json`):**
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "entry": "index.js",
  "triggers": ["keyword1"],
  "hooks": ["onAgent:turn:complete"],
  "permissions": ["read", "write"]
}
```

**Entry (`index.js`):**
```js
module.exports.register = function (api) {
  api.tool({
    name: 'my_tool',
    description: 'Description of what this tool does.',
    inputSchema: { type: 'object', properties: {} },
    async execute(input, context) {
      return { result: 'done' }
    }
  })
}
```

Plugin tool names are prefixed as `<id>__<toolName>`. Plugins go through the same permission gate as built-in tools.

---

## Apps

Connect apps from **Apps > Marketplace**. Credentials are encrypted with a machine-derived AES-256-GCM key before being stored in the database. Newly connected apps add their tools to the agent immediately without restarting WOS.

Supported apps:

- **Slack** - read channels and messages, post, react
- **GitHub** - read repos, issues, and PRs; create and comment
- **Jira** - read projects and issues; create and update tickets
- **Google** - Gmail labels, Drive folders, Calendar events

---

## Automations

Automations run the agent in headless mode on a schedule or in response to events. Configure them from the **Automations** tab.

Three trigger types:

- **schedule** - cron expression or natural language interval (e.g., `every 30 minutes`)
- **hook** - fires on internal events such as conversation end or project update
- **webhook** - HTTP POST to `http://localhost:47817/wos/automation/<slug>` with HMAC-SHA256 verification

Results can be delivered silently, as a desktop notification, posted to a chat, or sent to an external endpoint.

---

## Projects

Projects aggregate resources from connected apps into a unified view. Each project can link Slack channels, GitHub repos, Jira projects, Google Drive folders, meeting recordings, workspace files, and custom URLs.

The project refresh loop runs every 60 seconds and polls each linked resource at its configured cadence (Slack every 5-10 minutes, GitHub and Jira every 15-30 minutes, Drive every hour). AI summaries and health scores are generated on demand.

---

## Meetings

Record a meeting from the **Meetings** tab or upload an audio file. WOS transcribes the audio and runs the meeting agent to extract a summary, action items, decisions, and open questions.

The processing pipeline is fault-tolerant across restarts and progresses through these states:

```
queued -> reading -> transcribing -> analyzing -> done
```

---

## LLM Providers

Configure providers from **Settings > API Keys**. WOS supports:

- **Anthropic** (Claude models)
- **OpenAI** (GPT models)
- **OpenAI-compatible** providers (Together, Groq, OpenRouter, Ollama, vLLM)
- **RunPod** (serverless endpoints, one URL per model)

All API keys are encrypted with a machine-derived key. Moving the database to another machine will not allow decryption.

---

## Agent Modes

| Mode | Behavior |
|---|---|
| `default` | Read tools run automatically; write tools and shell commands prompt for approval |
| `plan` | Read-only exploration; the agent must propose a plan before any writes |
| `yolo` | All tools run automatically (shell deny patterns still apply) |

Bash deny patterns block destructive commands (`rm -rf /`, `mkfs`, fork bombs, `shutdown`) in all modes, including `yolo`.

---

## Testing

### Unit Tests

```bash
npm test
```

Runs the Vitest suite. The `pretest` hook rebuilds `better-sqlite3` against the host Node ABI before running.

### E2E Tests

The E2E harness in `e2e/` launches the real Electron app under Playwright control with a hermetic `userData` directory, captured main and renderer logs, and an in-process database query helper.

```bash
# Build the app first (required once before running E2E tests)
npm run e2e:build

# Sanity check: boot, window, database (about 1 second)
npm run e2e:smoke

# Interactive: open Playwright Inspector
npm run e2e:live

# Record video and trace to e2e/scratch/
npm run e2e:trace

# Full integration suite
npm run e2e:full
```

Always run E2E via the `npm run e2e:*` scripts rather than invoking Playwright directly. The `pre` hooks rebuild `better-sqlite3` against Electron's Node ABI, which differs from the host ABI.

Inside a test spec, three fixtures are available:

```ts
test('example', async ({ wos, harnessDb, dump }) => {
  await wos.window.click('text=Settings')
  const rows = await harnessDb.queryAll("SELECT * FROM workspaces")
  await dump('after-settings-open')  // writes screenshot, DOM, and logs to e2e/scratch/
})
```

Live LLM-backed tests are gated behind `WOS_E2E_LIVE=1`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `WOS_DEBUG=1` | Enable Chrome DevTools Protocol on port 9222 |
| `WOS_CDP_PORT=<port>` | Override the CDP debug port |
| `WOS_E2E=1` | Enable E2E mode (hermetic userData, exposed DB helper) |
| `WOS_USER_DATA=<path>` | Override userData path (used by E2E harness) |
| `WOS_DEV_OPENAI_KEY=<key>` | Seed an OpenAI key on first boot (dev only) |
| `WOS_E2E_AGENT_SCRIPT=<path>` | Path to a stubbed agent turn script for E2E tests |
| `WOS_E2E_LIVE=1` | Enable live LLM calls in E2E tests |

---

## Project Structure

```
wos/
├── electron/
│   ├── main/
│   │   ├── agent/          # Agent loop, permissions, intent classifier
│   │   ├── agents/         # Agent packs (wos, meeting, projects, code, automation)
│   │   ├── apps/           # Built-in app integrations
│   │   ├── automations/    # Schedule, hook, and webhook runtime
│   │   ├── context/        # Token counting, compaction, snapshot caching
│   │   ├── db/             # SQLite schema, migrations, and settings
│   │   ├── ipc/            # Main-to-renderer IPC handlers
│   │   ├── mcp/            # MCP server manager
│   │   ├── meetings/       # Recording, transcription, and analysis pipeline
│   │   ├── plugins/        # Plugin loader and file watcher
│   │   ├── projects/       # Project CRUD, resource refresh, and AI insights
│   │   ├── providers/      # LLM provider abstraction
│   │   ├── rules/          # Rule scanning and caching
│   │   ├── skills/         # Skill discovery and management
│   │   ├── tools/          # Built-in tools (Read, Write, Bash, Task, etc.)
│   │   ├── crypto.ts       # AES-256-GCM encryption
│   │   ├── index.ts        # App bootstrap and boot sequence
│   │   └── tray.ts         # System tray (app stays alive after window close)
│   └── preload/            # Context-isolated IPC bridge (window.wos.*)
├── src/                    # React renderer
│   ├── app/                # Root component and view routing
│   ├── store/              # Zustand stores
│   ├── types/              # TypeScript definitions
│   └── lib/                # Utilities and model capability data
├── e2e/                    # Playwright E2E tests and harness
└── tests/                  # Vitest unit tests
```

---

## Security

- All API keys, app credentials, MCP environment variables, and webhook secrets are encrypted with AES-256-GCM using a machine-derived key.
- The database cannot be decrypted on a different machine.
- The `~/.wos/` configuration directory never contains plaintext secrets.
- The renderer process never accesses the database or filesystem directly. All mutations go through the IPC bridge.
- Context isolation is enforced; the preload script exposes only a frozen `window.wos.*` API.
