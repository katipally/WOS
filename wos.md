# WOS Orchestrator Architecture — Runtime Contracts for Synthetic Dataset Generation

Sources: [electron/main/tools/index.ts](electron/main/tools/index.ts), [electron/main/agent/query.ts](electron/main/agent/query.ts), [electron/main/providers/types.ts](electron/main/providers/types.ts), [electron/main/apps/manager.ts](electron/main/apps/manager.ts), [electron/main/mcp/manager.ts](electron/main/mcp/manager.ts)

---

## 1. Tool Contracts

Core tool contract actually used by the orchestrator:

```ts
interface Tool {
  name: string
  description: string
  inputSchema: object
  readOnly?: boolean
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

interface ToolResult {
  output: string | object
  error?: string
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: object
}

interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  id?: string
  name?: string
  input?: unknown
  content?: unknown
  thinking?: string
  tool_use_id?: string
}
```

Important runtime details for dataset generation:

- The model only sees `name`, `description`, and `inputSchema`. `readOnly` exists internally but is not forwarded to providers.
- OpenAI tools are sent with `strict: false`, so the provider is not enforcing strict JSON-schema conformance.
- There is no local JSON-schema validator before tool execution. Most tools just cast `input as {...}` and run.
- Tool names are sanitized to `[A-Za-z0-9_-]` max length 64 before exposure.

Sources: [electron/main/providers/types.ts](electron/main/providers/types.ts), [electron/main/providers/openai.ts](electron/main/providers/openai.ts), [electron/main/tools/index.ts](electron/main/tools/index.ts)

---

### AskUser

Named TypeScript model:

```ts
type AskUserKind = 'text' | 'choice' | 'confirm' | 'fileDrop' | 'picker' | 'form'

interface AskUserFormField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean'
  placeholder?: string
  required?: boolean
}

interface AskUserInput {
  question: string
  kind?: AskUserKind
  choices?: string[]
  accept?: string[]
  source?: 'channel' | 'repo' | 'meeting' | 'calendar'
  pickerChoices?: Array<{ id: string; label: string; description?: string; [key: string]: unknown }>
  multi?: boolean
  allowFreeform?: boolean
  fields?: AskUserFormField[]
}
```

Actual schema shape:

```json
{
  "type": "object",
  "required": ["question"],
  "properties": {
    "question": { "type": "string" },
    "kind": {
      "type": "string",
      "enum": ["text", "choice", "confirm", "fileDrop", "picker", "form"]
    },
    "choices": { "type": "array", "items": { "type": "string" } },
    "allowFreeform": { "type": "boolean" },
    "accept": { "type": "array", "items": { "type": "string" } },
    "source": {
      "type": "string",
      "enum": ["channel", "repo", "meeting", "calendar"]
    },
    "pickerChoices": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "label"],
        "properties": {
          "id": { "type": "string" },
          "label": { "type": "string" },
          "description": { "type": "string" }
        }
      }
    },
    "multi": { "type": "boolean" },
    "fields": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["key", "label", "type"],
        "properties": {
          "key": { "type": "string" },
          "label": { "type": "string" },
          "type": {
            "type": "string",
            "enum": ["text", "textarea", "number", "boolean"]
          },
          "placeholder": { "type": "string" },
          "required": { "type": "boolean" }
        }
      }
    }
  }
}
```

AskUser execution details that matter for synthetic data:

- If `kind` is omitted, it defaults to `choice` when `choices` is non-empty, otherwise `text`.
- For `picker`, inline `pickerChoices` overrides snapshot-backed `source`.
- The tool always returns a single string.
- For `confirm`, the string is `"yes"` or `"no"`.
- For `fileDrop`, the returned string is JSON text like `[{"name":"...","path":"...","size":123,"type":"..."}]`.
- For `form`, the returned string is JSON text like `{"field":"value"}`.

Sources: [electron/main/tools/askUser.ts](electron/main/tools/askUser.ts), [src/types/index.ts](src/types/index.ts)

---

### Task / subagent dispatch

Named TypeScript model:

```ts
interface SubAgentInput {
  description: string
  prompt: string
  preset?: string
  presetKey?: string
  fork?: boolean
}
```

Actual schema shape:

```json
{
  "type": "object",
  "required": ["description", "prompt"],
  "properties": {
    "description": { "type": "string" },
    "prompt": { "type": "string" },
    "preset": { "type": "string" },
    "presetKey": { "type": "string" },
    "fork": { "type": "boolean" }
  }
}
```

Task execution details that matter for synthetic data:

- `fork` defaults to `true`.
- `presetKey` is accepted as an alias for `preset`.
- The root orchestrator can call `Task`, but spawned subagents do not see the `Task` tool because `queryLoop` removes it whenever `maxDepth > 0`.

Sources: [electron/main/tools/subAgent.ts](electron/main/tools/subAgent.ts), [electron/main/agent/query.ts](electron/main/agent/query.ts)

---

### Connected-app tool signatures

These are the exact schema-equivalent signatures extracted from each app's `inputSchema`.

```ts
// Slack
SlackSendMessage(args: { channel: string; text: string; thread_ts?: string })
SlackListChannels(args?: { types?: string /* default 'public_channel,private_channel' */; limit?: number /* default 100 */ }) // readOnly
SlackSearchMessages(args: { query: string; count?: number /* default 20 */ }) // readOnly
SlackGetChannelHistory(args: { channel: string; limit?: number /* default 50 */; oldest?: string }) // readOnly
SlackGetUserInfo(args: { user: string }) // readOnly
SlackUploadFile(args: { channels: string; content: string; filename: string; title?: string; initial_comment?: string })
SlackCreateChannel(args: { name: string; is_private?: boolean /* default false */ })
SlackReactToMessage(args: { channel: string; timestamp: string; name: string })
SlackUpdateMessage(args: { channel: string; ts: string; text: string })
SlackDeleteMessage(args: { channel: string; ts: string })
SlackStartThread(args: { channel: string; thread_ts: string; text: string })

// GitHub
GitHubListRepos(args?: {
  visibility?: 'all' | 'public' | 'private'
  sort?: 'created' | 'updated' | 'pushed' | 'full_name'
  per_page?: number
  page?: number
}) // readOnly

GitHubGetRepo(args: { owner: string; repo: string }) // readOnly
GitHubCreateRepo(args: { name: string; description?: string; private?: boolean; auto_init?: boolean })
GitHubListBranches(args: { owner: string; repo: string }) // readOnly
GitHubCreateBranch(args: { owner: string; repo: string; branch_name: string; from_sha: string })
GitHubListIssues(args: {
  owner: string
  repo: string
  state?: 'open' | 'closed' | 'all'
  labels?: string
  assignee?: string
  per_page?: number
  page?: number
}) // readOnly

GitHubGetIssue(args: { owner: string; repo: string; issue_number: number }) // readOnly
GitHubCreateIssue(args: { owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] })
GitHubUpdateIssue(args: { owner: string; repo: string; issue_number: number; title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] })
GitHubAddIssueComment(args: { owner: string; repo: string; issue_number: number; comment: string })
GitHubListPRs(args: { owner: string; repo: string; state?: 'open' | 'closed' | 'all'; per_page?: number; page?: number }) // readOnly
GitHubGetPR(args: { owner: string; repo: string; pr_number: number }) // readOnly
GitHubCreatePR(args: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean })
GitHubGetFileContent(args: { owner: string; repo: string; path: string; ref?: string }) // readOnly
GitHubSearchCode(args: { query: string; per_page?: number }) // readOnly
GitHubListNotifications(args?: { all?: boolean }) // readOnly
GitHubMarkNotificationsRead(args?: {})

// Google Workspace
GmailListEmails(args?: { query?: string; max_results?: number }) // readOnly
GmailGetEmail(args: { message_id: string }) // readOnly
GmailSendEmail(args: { to: string; cc?: string; subject: string; body: string; thread_id?: string })
GmailSearchEmails(args: { query: string; max_results?: number }) // readOnly
GmailCreateDraft(args: { to: string; subject: string; body: string })

GoogleCalendarListEvents(args?: { time_min?: string; time_max?: string; max_results?: number }) // readOnly
GoogleCalendarGetEvent(args: { event_id: string }) // readOnly
GoogleCalendarCreateEvent(args: {
  summary: string
  description?: string
  start_time: string
  end_time: string
  time_zone?: string
  attendees?: string[]
  add_meet_link?: boolean
})
GoogleCalendarUpdateEvent(args: {
  event_id: string
  summary?: string
  description?: string
  start_time?: string
  end_time?: string
  time_zone?: string
})

GoogleDriveListFiles(args?: { query?: string; page_size?: number }) // readOnly
GoogleDriveGetFile(args: { file_id: string }) // readOnly
GoogleDriveUploadFile(args: { name: string; content: string; mime_type?: string; folder_id?: string })
GoogleDriveCreateFolder(args: { name: string; parent_id?: string })

// Jira
JiraListProjects(args?: {}) // readOnly
JiraSearchIssues(args: { jql: string; max_results?: number; next_page_token?: string }) // readOnly
JiraGetIssue(args: { issue_key: string }) // readOnly
JiraCreateIssue(args: { project_key: string; issue_type: string; summary: string; description?: string; priority?: string })
JiraUpdateIssue(args: { issue_key: string; summary?: string; priority?: string })
JiraAddComment(args: { issue_key: string; comment: string })
JiraAssignIssue(args: { issue_key: string; account_id: string })
JiraTransitionIssue(args: { issue_key: string; status_name: string })
JiraGetBoards(args?: {}) // readOnly
JiraListSprints(args: { board_id: number; state?: 'active' | 'future' | 'closed' }) // readOnly
```

Connected-app manifest/auth/scopes:

```ts
Slack authFields:
- botToken: required
- userToken: optional
- signingSecret: optional
Slack scopes:
- chat:write, channels:read, channels:history, groups:read, groups:history,
  im:read, im:history, mpim:read, mpim:history, users:read, files:write,
  search:read (user token only)

GitHub authFields:
- token: required
GitHub scopes:
- repo, issues, pull_requests, notifications, code_search

Google authType:
- oauth
Google authFields:
- clientId: required
- clientSecret: required
Google scopes:
- gmail.modify, calendar, drive

Jira authFields:
- baseUrl: required
- email: required
- token: required
Jira scopes:
- read:jira-work, write:jira-work, read:jira-user
```

Sources: [electron/main/apps/slack/tools.ts](electron/main/apps/slack/tools.ts), [electron/main/apps/github/tools.ts](electron/main/apps/github/tools.ts), [electron/main/apps/google/tools.ts](electron/main/apps/google/tools.ts), [electron/main/apps/jira/tools.ts](electron/main/apps/jira/tools.ts), [electron/main/apps/slack/index.ts](electron/main/apps/slack/index.ts), [electron/main/apps/github/index.ts](electron/main/apps/github/index.ts), [electron/main/apps/google/index.ts](electron/main/apps/google/index.ts), [electron/main/apps/jira/index.ts](electron/main/apps/jira/index.ts)

**Important caveat:** Some app skill markdown still uses stale lowercase snake_case tool names. Do not train on those names. Train on the actual runtime names above.

---

## 2. System Prompt and Meta-Prompts

Exact base system prompt:

```text
You are WOS, an AI agent assistant. You have access to tools to help accomplish tasks.
When using tools, be precise and thorough. Always explain what you are doing.
If you need clarification, use the AskUser tool.
```

Exact WOS policy block appended for the default orchestrator:

```text
## Reuse what you already know
Before calling `AskUser`, scan this conversation. If the user already supplied the answer (channel name, target, time, message body, etc.) in an earlier turn - even if a previous attempt failed - reuse it. Never re-ask for information that is already in scope.

## Creating automations
When the user wants something to run later, on a schedule, on an event, or via webhook, follow this process:

### Step 1 - Gather context silently
Call `automation_listConnectedApps()` to see what services are available. Do not narrate this.

### Step 2 - Resolve all resources before creating
The automation message is executed as-is by an autonomous agent with no access to the current conversation. It must be a complete, direct, self-contained task instruction.

Never use placeholder text like "the specified channel", "the selected repo", "the target", or "the user's channel". Always substitute the actual value. If you do not know the actual value yet, you must ask first.

For each unresolved resource:
1. Fetch the list, for example `SlackListChannels` or `GitHubListRepos`.
2. Ask with `AskUser` kind:`picker`, pass `pickerChoices` with the fetched list and `allowFreeform:true`.

### Step 3 - Write the message as a direct task, not a meta-instruction
The message field is what the autonomous agent will execute. It describes what to do, not "create an automation that...".

### Step 4 - Call `automation_create` once
- `message`: direct executable task with all resources resolved
- `toolsAllow: []`: empty means all available tools are allowed
- `kind` plus the schedule, hook, or webhook config
- `delivery`: infer from the request

Never claim the automation exists until `automation_create` returns success.

## Asking the user
Any clarifying question, confirmation, choice, or request for missing input must go through the `AskUser` tool. Never ask the user a question in plain prose. Ask at most one focused question per turn.

## Subagent routing
When the request is primarily about meetings, recordings, calendar events, transcripts, action items, or discussion follow-ups, delegate to the meeting subagent via the `Task` tool with `preset: "meeting"`.

When the request is about a specific WOS Project, first call `wos_projects_find` to resolve the name, then delegate to the projects subagent via the `Task` tool with `preset: "projects"`.

Otherwise handle the request yourself.
```

Exact plan-mode addendum:

```text
## Planning Mode
You are in PLAN MODE. Think through the request and produce a detailed numbered plan
describing every action you will take (which files to read, edit, create, or delete,
and which tools you will invoke in what order).

When your plan is ready, call the `ExitPlanMode` tool with the full plan text as the
`plan` argument. This will present the plan to the user for approval. Do NOT call
any other write/edit/bash tools before `ExitPlanMode` - only read-only exploration
is allowed (Read, Glob, Grep).
```

Exact yolo-mode addendum:

```text
## Autonomous Mode
You are in YOLO (fully autonomous) mode. Execute all tasks without asking for permission.
Make decisions autonomously and proceed efficiently.
```

Actual runtime prompt assembly order in `queryLoop`:

1. Optional connected-app section, if any enabled apps are connected.
2. `BASE_SYSTEM_PROMPT`
3. Optional plan-mode or yolo-mode addendum
4. Optional workspace section: `## Workspace\nCurrent workspace: ...`
5. Optional rules section from `buildRulesPromptSection()`
6. Optional skills section from `buildSkillIndex()`
7. Optional custom instructions from agent settings
8. Agent definition prompt, which for `wos` is `WOS_AGENT_POLICY`
9. Optional append section, which the top-level runner uses for recalled memory via `<memory>...</memory>`

Dynamic prompt fragments you may want to synthesize:

```text
## Connected Apps
- {AppName} ({appId}) — tools: {count}, scopes: {{snapshotScope1, snapshotScope2}}

## Active rules
### {ruleName}
{full body}

## Conditional rules (call `ReadRule` when a trigger fires)
- **{idPrefix}** {name} — {description}{matches...}

## Available skills
Call the `ReadSkill` tool with an id below when one of the triggers matches.

- **{idPrefix}** — {name}: {description} [triggers: ...]

## App skills
Call the `ReadAppSkill` tool with `appId` + `skillId` to load the body.

- **{appId}/{skillId}** ({appName}) — {description}

<memory>
- fact 1
- fact 2
</memory>
```

Hard constraints that are not just prompt-level:

- Default tool permissions: `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `AskUser`, `Task`, `TodoWrite`, `EnterPlanMode`, `ExitPlanMode` are auto-allowed; `Write`, `Edit`, `Bash` ask for permission in default mode.
- Dangerous Bash regexes are denied outright.
- `validatePath()` blocks file access outside the workspace.
- Hooks can block or mutate tool args/results and can block subagent creation.

Sources: [electron/main/training/orchestration/prompt.ts](electron/main/training/orchestration/prompt.ts), [electron/main/agent/query.ts](electron/main/agent/query.ts), [electron/main/rules/manager.ts](electron/main/rules/manager.ts), [electron/main/skills/manager.ts](electron/main/skills/manager.ts), [electron/main/memory/memoryService.ts](electron/main/memory/memoryService.ts), [electron/main/agent/permissions.ts](electron/main/agent/permissions.ts), [electron/main/hooks/manager.ts](electron/main/hooks/manager.ts)

---

## 3. Task Handoff, Message History, and Model-Facing Tool Observations

Exact `Task` execution flow:

1. The model emits a `tool_use_start` event for `Task`.
2. `queryLoop` permission-checks it, then calls `executeTools()`.
3. `executeTools()` runs pre-tool hooks, executes `subAgentTool.execute()`, and then post-tool hooks.
4. `Task` checks subagent depth and breadth limits.
5. If `conversationId` exists, it writes ledger rows into `subagent_runs` and `tasks`.
6. It runs `BeforeSubagent` hooks. Hooks can block here.
7. It emits `subagent_start`.
8. If `fork` is true, it copies `parentMessages` into the child query as inherited history.
9. If `preset` is set, it resolves that agent's model, mode, prompt, and API-key override via `resolveAgent(preset)`.
10. It calls `queryLoop()` for the child with:
    - `messages: inheritedMessages`
    - `userMessage: prompt`
    - `model: parentModel or preset model`
    - `mode: parentMode or preset mode`
    - `reasoningEffort: parentReasoningEffort`
    - `systemPromptOverride: preset/system prompt if preset exists`
    - `apiKeyOverride`
    - `maxDepth: 1`
    - `agentKey: preset ?? 'wos'`
    - `skipIntent: true`
11. It forwards all child events upward as `subagent_event`.
12. It accumulates only child `text_delta` into the final `result` string.
13. On success it returns `{ output: result || '(subagent completed with no output)' }`.
14. On failure it returns `{ output: 'Subagent error: ...', error: '...' }`.

Current depth/breadth behavior:

- Configured defaults are `maxDepth = 3`, `maxBreadth = 5`.
- In current live architecture, subagents do not get the `Task` tool because `queryLoop` strips it whenever `maxDepth > 0`. So nesting is effectively disabled even though the depth checks exist.

Sources: [electron/main/tools/subAgent.ts](electron/main/tools/subAgent.ts), [electron/main/agent/query.ts](electron/main/agent/query.ts), [electron/main/agent/settings.ts](electron/main/agent/settings.ts), [electron/main/agent/subagentRegistry.ts](electron/main/agent/subagentRegistry.ts), [electron/main/db/schema.ts](electron/main/db/schema.ts)

---

### Exact payload sent into `Task`

Model-facing tool call input is exactly the `Task` `inputSchema` shown earlier. Example valid payload:

```json
{
  "description": "Review the incident channel and produce a summary",
  "prompt": "Read the last 12 hours of Slack messages from #incident-ops. Summarize impact, mitigations, blockers, owners, and open follow-ups.",
  "preset": "meeting",
  "fork": true
}
```

---

### Exact payload returned back to the orchestrator

There are three relevant layers.

Internal tool return from `Task`:

```ts
type ToolResult = {
  output: string | object
  error?: string
}
```

UI/event-layer result emitted by `queryLoop` after tool execution:

Success:
```json
{
  "type": "tool_result",
  "toolId": "call_123",
  "result": "final subagent text here"
}
```

Failure:
```json
{
  "type": "tool_result",
  "toolId": "call_123",
  "result": null,
  "error": "Max subagent breadth (5) exceeded"
}
```

Model-facing next-turn history block appended by `queryLoop`:

Success:
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_123",
      "content": "\"final subagent text here\""
    }
  ]
}
```

Failure:
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_123",
      "content": "Error: Max subagent breadth (5) exceeded"
    }
  ]
}
```

Two important quirks:

- Successful string outputs are wrapped with `JSON.stringify`, so the model sees quoted strings.
- If a tool returns both `output` and `error`, the model-facing history uses only the error string, not the `output`.

---

### How message history is actually constructed

Runtime `ConversationMessage[]` is built like this:

- `system` is not part of the array. It is sent separately as `instructions` to OpenAI and `system` to Anthropic.
- Roles in runtime history are only `user` and `assistant`.
- Tool results are not a separate runtime role. They are encoded as a synthetic `user` message whose `content` is an array of `{ type: 'tool_result', ... }` blocks.
- Saved assistant DB blocks store `tool_use` plus embedded `result`/`error`, and `AgentRunner` reconstructs synthetic `user` tool-result turns from those saved assistant blocks.
- Attachments are appended into the current user text as:
  ```text
  <file name="filename.ext">
  ...content...
  </file>
  ```

Exact runtime example:

```json
[
  {
    "role": "user",
    "content": "Read the last 24 hours of Slack messages from #engineering and summarize them."
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_1",
        "name": "SlackGetChannelHistory",
        "input": {
          "channel": "#engineering",
          "limit": 50
        }
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_1",
        "content": "\"[1715000000.000100] U123: message one\\n[1715000010.000200] U456: message two\""
      }
    ]
  },
  {
    "role": "assistant",
    "content": "Here is the summary..."
  }
]
```

Provider formatting details:

- OpenAI converts assistant `tool_use` blocks into `function_call` items and user `tool_result` blocks into `function_call_output` items.
- Anthropic passes block arrays through directly.
- The runtime does stream `thinking_delta` / `reasoning_delta`, but those are UI-only. There is no persistent scratchpad or explicit `inner_monologue` block in next-turn model history.
- `AgentRunner` persists reasoning as `reasoning` UI blocks, but when rebuilding provider history it only reconstructs text, tool_use, and synthetic tool_result turns.

**Answer to scratchpad question:** No, there is no explicit persisted inner-monologue channel. Tool calls are emitted directly. Any reasoning stream is transient/UI-facing.

Sources: [electron/main/agent/runner.ts](electron/main/agent/runner.ts), [electron/main/providers/openai.ts](electron/main/providers/openai.ts), [electron/main/providers/anthropic.ts](electron/main/providers/anthropic.ts), [electron/main/providers/types.ts](electron/main/providers/types.ts)

---

### Important dataset point: runtime roles vs training schema

The repo's training schema is not identical to runtime message roles. Runtime uses `user` and `assistant` only; the training schema normalizes tool events with a separate `tool` role.

Existing repo dataset schema:

```ts
interface DatasetToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface DatasetToolResult {
  toolCallId: string
  name: string
  output: string | Record<string, unknown> | Array<unknown>
  error?: string
}

interface DatasetEvent {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: DatasetToolCall[]
  toolResult?: DatasetToolResult
}

interface DatasetTarget {
  assistantText: string
  toolCalls: DatasetToolCall[]
  stopReason: 'end_turn' | 'tool_use'
}

interface OrchestrationDatasetRecord {
  id: string
  scenarioId: string
  split: 'train' | 'validation' | 'test'
  mode: 'default' | 'plan' | 'yolo'
  systemPrompt: string
  tools: DatasetTool[]
  conversation: DatasetEvent[]
  target: DatasetTarget
  metadata: DatasetMetadata
}
```

Sources: [electron/main/training/orchestration/types.ts](electron/main/training/orchestration/types.ts), [electron/main/training/orchestration/teacherGenerate.ts](electron/main/training/orchestration/teacherGenerate.ts)

---

## 4. Error Surfacing, Recovery, and Tool Protocols

Generic error propagation path:

1. App tools wrap their `execute()` bodies with `wrapToolErrors()`.
2. Exceptions become:
   ```json
   { "output": "", "error": "<humanized message>" }
   ```
3. `queryLoop` emits:
   ```json
   { "type": "tool_result", "toolId": "...", "result": null, "error": "<message>" }
   ```
4. Next-turn model history becomes:
   ```json
   {
     "role": "user",
     "content": [
       {
         "type": "tool_result",
         "tool_use_id": "...",
         "content": "Error: <message>"
       }
     ]
   }
   ```

---

### Representative exact app-side humanized errors

**Slack:**
- `channel_not_found` → `Channel not found. Make sure the channel ID is correct and the bot is a member.`
- `not_in_channel` → `The bot is not in this channel. Invite it with /invite @bot-name first.`
- `invalid_auth` → `Slack token is invalid. Please check your Bot Token in Settings → Apps → Slack.`

**GitHub:**
- HTTP 401 → `Invalid token. Regenerate your GitHub Personal Access Token at github.com/settings/tokens.`
- HTTP 403 → `Access denied. Make sure the token has the required scopes (repo, notifications).`
- HTTP 429 retry exhaustion → `GitHub rate limit reached. Please wait a minute before trying again.`

**Google:**
- 401 → `Google session expired. Please reconnect Google in Settings → Apps → Google.`
- 403 insufficient scopes → `Google permission denied. Make sure you granted the required scopes when connecting Google.`
- 404 → `Google resource not found. Check that the ID or path is correct.`

**Jira:**
- 401 → `Invalid credentials. Check your Atlassian email and API token at id.atlassian.com/manage-profile/security/api-tokens.`
- 403 → `Access denied. Make sure your Atlassian account has access to this Jira workspace.`
- 404 → `Jira workspace not found. Check your Base URL (e.g. https://yourorg.atlassian.net).`

---

### Other exact failure shapes to synthesize

Unknown tool:
```json
{ "output": null, "error": "Unknown tool: BadToolName" }
```

Hook block:
```json
{ "output": "", "error": "Blocked by hook: <reason>" }
```

Permission denial:
```json
{ "type": "tool_result", "toolId": "call_123", "result": null, "error": "Permission denied by user" }
```

Subagent depth block:
```json
{
  "output": "Subagent spawn blocked: maximum depth of 3 reached. Cannot spawn further nested subagents.",
  "error": "Max subagent depth (3) exceeded"
}
```

Two recovery-relevant implications:

- Because OpenAI tool calling is `strict: false` and local validation is loose, malformed or incomplete args can reach the tool body and then fail downstream as API errors.
- The orchestrator sees those failures as plain text in the next `tool_result` content: `Error: ...`. That is the exact recovery trajectory format you should mimic.

Sources: [electron/main/apps/slack/api.ts](electron/main/apps/slack/api.ts), [electron/main/apps/github/api.ts](electron/main/apps/github/api.ts), [electron/main/apps/google/api.ts](electron/main/apps/google/api.ts), [electron/main/apps/jira/api.ts](electron/main/apps/jira/api.ts), [electron/main/tools/index.ts](electron/main/tools/index.ts), [electron/main/agent/query.ts](electron/main/agent/query.ts), [electron/main/hooks/manager.ts](electron/main/hooks/manager.ts)

---

### Protocol answer

Slack, GitHub, Google Workspace, and Jira are **not** implemented through MCP in this repo. They are built-in app modules:

- Each app exports an `AppModule` with `manifest`, `test(creds)`, `buildTools(creds)`, optional `snapshot`, optional `skills`, and optional `projectResourceTypes`.
- `buildConnectedAppTools()` calls `app.buildTools(c.creds)` for each enabled connected app.
- The actual transport is direct vendor HTTP `fetch` against Slack API, GitHub REST API, Google APIs, and Jira REST API, with OAuth/token refresh where needed.
- MCP is a separate subsystem. Its tools are dynamically exposed as `mcp__<serverPrefix>__<toolName>` and invoke `client.callTool(...)`.

Architectural split:

```text
Built-in app tools:
  WOS app manager -> app module -> vendor REST/OAuth wrapper -> ToolResult

MCP tools:
  WOS MCP manager -> MCP client transport (stdio/http/sse) -> MCP server -> ToolResult
```

Sources: [electron/main/apps/types.ts](electron/main/apps/types.ts), [electron/main/apps/manager.ts](electron/main/apps/manager.ts), [electron/main/apps/slack/api.ts](electron/main/apps/slack/api.ts), [electron/main/apps/github/api.ts](electron/main/apps/github/api.ts), [electron/main/apps/google/api.ts](electron/main/apps/google/api.ts), [electron/main/apps/jira/api.ts](electron/main/apps/jira/api.ts), [electron/main/mcp/manager.ts](electron/main/mcp/manager.ts)
