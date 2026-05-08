import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  name: text('name').notNull(),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),
})

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('New Conversation'),
  workspaceId: text('workspace_id'),
  model: text('model').notNull().default(''),
  mode: text('mode').notNull().default('default'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  tokenCount: integer('token_count').notNull().default(0),
  contextLimit: integer('context_limit').notNull().default(200000),
  isCompacted: integer('is_compacted', { mode: 'boolean' }).notNull().default(false),
  // The agent persona (wos | meeting | projects | <custom>) used for this conversation.
  // Falls back to 'wos' when null (added in migration v7).
  agentKey: text('agent_key'),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role').notNull(),
  blocks: text('blocks', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  tokenCount: integer('token_count').default(0),
  // Branching: messages edited from the same point share a branchGroupId.
  // branchIndex 0 = original, 1 = first edit, 2 = second edit, etc.
  branchGroupId: text('branch_group_id'),
  branchIndex: integer('branch_index').default(0),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const apiKeys = sqliteTable('api_keys', {
  provider: text('provider').primaryKey(),
  encryptedKey: text('encrypted_key').notNull(),
  iv: text('iv').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const permissionGrants = sqliteTable('permission_grants', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  toolName: text('tool_name').notNull(),
  scope: text('scope').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Built-in Apps (Slack, GitHub, etc.) — one row per connected app.
// `credsJson` is encrypted JSON blob of whatever auth material the app needs
// (token, signing secret, refresh token, …). `iv` + `encryptedKey` pattern
// mirrors `api_keys` and uses the same AES-256 machine-derived key.
export const appConnections = sqliteTable('app_connections', {
  appId: text('app_id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  encryptedCreds: text('encrypted_creds').notNull(),
  iv: text('iv').notNull(),
  metadataJson: text('metadata_json', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// User-configured MCP servers. `envEncrypted`/`envIv` store a JSON object
// with encrypted env values (for secrets like API tokens).
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull(), // 'stdio' | 'http' | 'sse'
  command: text('command'),
  argsJson: text('args_json', { mode: 'json' }),
  url: text('url'),
  envEncrypted: text('env_encrypted'),
  envIv: text('env_iv'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  toolPrefix: text('tool_prefix'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Skills discovered from `~/.wos/skills/**` and `<workspace>/.wos/skills/**`.
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  source: text('source').notNull(), // 'user' | 'workspace'
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  path: text('path').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  triggersJson: text('triggers_json', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Rules — both user-level (~/.wos/rules/*.md) and per-workspace
// (<workspace>/.cursor/rules/*.mdc). Frontmatter fields are flattened into
// columns so we can filter cheaply without parsing every time.
export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(), // 'user' | 'workspace'
  workspaceId: text('workspace_id'),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  path: text('path').notNull(),
  alwaysApply: integer('always_apply', { mode: 'boolean' }).notNull().default(false),
  globs: text('globs', { mode: 'json' }),
  body: text('body').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Agent settings — per-agent free-form configuration. The shape of `configJson`
// is defined by each agentDef's `settingsSchema`; the runner merges `defaults`
// from the agentDef with this row at resolve time. There is no inheritance.
//
// `model`, `mode`, and `systemPrompt` are top-level columns for cheap lookup;
// everything else lives inside `configJson`.
export const agentSettings = sqliteTable('agent_settings', {
  agentKey: text('agent_key').primaryKey(),
  model: text('model'),
  mode: text('mode'),
  systemPrompt: text('system_prompt'),
  configJson: text('config_json', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Provider instances — one row per configured upstream model provider. Built-in
// 'openai' and 'anthropic' rows are seeded from legacy api_keys on first boot
// (migration v4). Users can also add multiple OpenAI-compatible instances
// (Together, Groq, OpenRouter, Ollama, vLLM, …) each with their own baseURL,
// custom headers, and probed apiStyle ('responses' | 'chat-completions').
export const providerInstances = sqliteTable('provider_instances', {
  id: text('id').primaryKey(), // uuid; also stable key for keystore lookups
  kind: text('kind').notNull(), // 'openai' | 'anthropic' | 'openai-compatible'
  label: text('label').notNull(),
  baseUrl: text('base_url'), // null for built-in providers
  apiStyle: text('api_style'), // 'responses' | 'chat-completions' (probed)
  encryptedKey: text('encrypted_key').notNull(),
  iv: text('iv').notNull(),
  modelsJson: text('models_json', { mode: 'json' }).notNull().default('[]'),
  capabilitiesJson: text('capabilities_json', { mode: 'json' }), // optional probed caps
  customHeadersJson: text('custom_headers_json', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// User-defined agents (added in migration v6). Built-in agents (wos, meeting,
// projects, intent, …) live in code under electron/main/agent/agentDefs/*.
// Custom rows let users define new personas — name + acceptedTags + defaults +
// systemPrompt — without code changes.
export const customAgents = sqliteTable('custom_agents', {
  agentKey: text('agent_key').primaryKey(),
  label: text('label').notNull(),
  systemPrompt: text('system_prompt'),
  acceptedTagsJson: text('accepted_tags_json', { mode: 'json' }).notNull().default('[]'),
  defaultsJson: text('defaults_json', { mode: 'json' }).notNull().default('{}'),
  surfaceInSettings: integer('surface_in_settings', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Meeting records — from live sessions or uploads
export const meetings = sqliteTable('meetings', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('Untitled Meeting'),
  source: text('source').notNull(), // 'live' | 'upload' | 'calendar'
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  duration: integer('duration'), // seconds; computed after end
  transcript: text('transcript'), // full transcript text
  summary: text('summary'), // LLM-generated summary
  actionItemsJson: text('action_items_json', { mode: 'json' }), // [{owner, text, due}]
  decisionsJson: text('decisions_json', { mode: 'json' }), // [{decision, context}]
  speakerMapJson: text('speaker_map_json', { mode: 'json' }), // {name: [segments]} for live
  sourceUri: text('source_uri'), // Meet URL or file path
  agentKey: text('agent_key').default('meeting'), // which agent processed this
  processingStatus: text('processing_status').default('done'), // queued | reading | transcribing | analyzing | done | error | interrupted
  processingMessage: text('processing_message'),
  processingProgress: integer('processing_progress').default(100),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const meetingActivity = sqliteTable('meeting_activity', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id'),
  type: text('type').notNull(),
  status: text('status').notNull(),
  label: text('label').notNull(),
  detailJson: text('detail_json', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// FTS5 full-text search over meetings
export const meetingsFts = sqliteTable('meetings_fts', {
  rowid: integer('rowid').primaryKey(),
  title: text('title'),
  transcript: text('transcript'),
  summary: text('summary'),
})

// ─── Automations ─────────────────────────────────────────────────────────────
// New schema is defined in Phase 2 of the automations rebuild (see plan.md).
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  type: text('type').notNull(), // 'scheduled' | 'subagent' | 'flow' | 'hook'
  status: text('status').notNull().default('queued'), // 'queued' | 'running' | 'success' | 'error' | 'cancelled' | 'paused'
  title: text('title').notNull(),
  payload: text('payload', { mode: 'json' }),
  conversationId: text('conversation_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const taskSteps = sqliteTable('task_steps', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  idx: integer('idx').notNull(),
  status: text('status').notNull(),
  label: text('label').notNull(),
  output: text('output'),
  error: text('error'),
  ts: integer('ts', { mode: 'timestamp' }).notNull(),
})

// Sub-agent runs — invoked via wos.spawn_subagent tool, rendered inline in chat.
export const subagentRuns = sqliteTable('subagent_runs', {
  id: text('id').primaryKey(),
  parentMessageId: text('parent_message_id'),
  conversationId: text('conversation_id').notNull(),
  status: text('status').notNull().default('running'),
  goal: text('goal').notNull(),
  summary: text('summary'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
})

// ─── Automations v2 ──────────────────────────────────────────────────────────
// OpenClaw-parity rebuild. See plan.md and electron/main/automations/.

export type AutomationKind =
  | 'schedule'
  | 'hook'
  | 'webhook'

export type AutomationResultDelivery = 'silent' | 'notify' | 'chat' | 'external'

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // AutomationKind
  name: text('name').notNull(),
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  prompt: text('prompt').notNull().default(''),
  toolsAllow: text('tools_allow', { mode: 'json' }).notNull().default('[]'),
  config: text('config', { mode: 'json' }).notNull().default('{}'),
  resultDelivery: text('result_delivery').notNull().default('silent'),
  resultTarget: text('result_target'),
  owner: text('owner'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
})

export const automationRuns = sqliteTable('automation_runs', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  status: text('status').notNull(), // 'running' | 'success' | 'error' | 'cancelled' | 'dryrun'
  trigger: text('trigger', { mode: 'json' }),
  toolCalls: text('tool_calls', { mode: 'json' }),
  output: text('output'),
  error: text('error'),
  scratchDir: text('scratch_dir'),
})

export const automationWebhooks = sqliteTable('automation_webhooks', {
  automationId: text('automation_id').primaryKey(),
  slug: text('slug').notNull().unique(),
  secretHmac: text('secret_hmac').notNull(),
  publicUrl: text('public_url'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
})

export const automationHeartbeats = sqliteTable('automation_heartbeats', {
  automationId: text('automation_id').primaryKey(),
  intervalSec: integer('interval_sec').notNull(),
  jitterSec: integer('jitter_sec').notNull().default(0),
  lastTickAt: integer('last_tick_at', { mode: 'timestamp' }),
})

export const automationTaskFlows = sqliteTable('automation_task_flows', {
  automationId: text('automation_id').primaryKey(),
  currentStep: integer('current_step').notNull().default(0),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  revision: integer('revision').notNull().default(0),
  state: text('state', { mode: 'json' }).notNull().default('{}'),
})

export const automationTaskFlowSteps = sqliteTable('automation_task_flow_steps', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull(),
  idx: integer('idx').notNull(),
  label: text('label').notNull(),
  status: text('status').notNull().default('pending'),
  requiresHuman: integer('requires_human', { mode: 'boolean' }).notNull().default(false),
  input: text('input', { mode: 'json' }),
  output: text('output', { mode: 'json' }),
  error: text('error'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const automationTasksLedger = sqliteTable('automation_tasks_ledger', {
  id: text('id').primaryKey(),
  automationId: text('automation_id'),
  runId: text('run_id'),
  kind: text('kind').notNull(),
  payload: text('payload', { mode: 'json' }),
  status: text('status').notNull().default('open'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

export const automationConsentGrants = sqliteTable('automation_consent_grants', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull(),
  tool: text('tool').notNull(),
  scope: text('scope').notNull().default('always'),
  grantedAt: integer('granted_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
})

// ─── App Context Snapshots ────────────────────────────────────────────────────
// Lightweight cache of connected-app resources (channels, repos, etc.).
// Populated on connect, refreshed on schedule. The cache is awareness-only —
// agent answers always use live tool calls.
export const appContextSnapshots = sqliteTable('app_context_snapshots', {
  appId: text('app_id').notNull(),
  scope: text('scope').notNull(),
  dataJson: text('data_json').notNull().default('[]'),
  fetchedAt: integer('fetched_at').notNull(),
  etag: text('etag'),
  // Optional project scoping — set when the snapshot was fetched in the
  // context of a specific project resource (e.g. a single Slack channel
  // linked to project Atlas). Null for app-wide catalogue snapshots.
  projectId: text('project_id'),
  resourceRef: text('resource_ref'),
})

// ─── Projects ─────────────────────────────────────────────────────────────────
// First-class hub linking resources from connected apps + WOS-native to a
// single dashboard. See plan.md for full spec.

export type ProjectStatus = 'draft' | 'active' | 'paused' | 'shipped' | 'archived'
export type ProjectRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  icon: text('icon'),                    // emoji or short string
  color: text('color'),                  // hex / css color
  status: text('status').notNull().default('draft'),
  ownerEmail: text('owner_email'),
  description: text('description'),
  summary: text('summary'),              // latest short AI summary cached
  healthScore: integer('health_score'),  // 0..100
  riskLevel: text('risk_level'),         // ProjectRiskLevel
  modelOverride: text('model_override'), // optional per-project model id
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  metadataJson: text('metadata_json', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
})

// Each row links one external/native resource to a project.
// `kind` is namespaced by source app or native domain:
//   slack:channel · github:repo · jira:project · jira:epic · google:calendar
//   google:drive_folder · google:gmail_label · meeting · workspace:file ·
//   mcp:resource · conversation · note · custom_link
export const projectResources = sqliteTable('project_resources', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref', { mode: 'json' }).notNull(), // app-specific identifier blob
  label: text('label').notNull(),
  description: text('description'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
  lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp' }),
  refreshIntervalSec: integer('refresh_interval_sec'),
})

// One row per widget instance placed on a tab of a project's detail view.
export const projectWidgets = sqliteTable('project_widgets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  tab: text('tab').notNull(),            // 'overview' | 'activity' | ...
  widgetKind: text('widget_kind').notNull(),
  configJson: text('config_json', { mode: 'json' }),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
  w: integer('w').notNull().default(4),
  h: integer('h').notNull().default(3),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  sort: integer('sort').notNull().default(0),
})

export const projectAlerts = sqliteTable('project_alerts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  ruleKind: text('rule_kind').notNull(), // 'p1_ticket' | 'pr_awaiting_review' | 'mention' | 'meeting_soon' | 'ai_risk'
  configJson: text('config_json', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  severity: text('severity').notNull().default('important'), // 'all' | 'important' | 'off'
  lastFiredAt: integer('last_fired_at', { mode: 'timestamp' }),
})

// AI-generated summaries (executive, weekly, risk, decisions).
// `sourceFingerprint` lets us decide if regeneration is needed.
export const projectSummaries = sqliteTable('project_summaries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  kind: text('kind').notNull(),         // 'executive' | 'weekly' | 'risk' | 'decisions'
  body: text('body').notNull(),
  modelUsed: text('model_used'),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  generatedAt: integer('generated_at', { mode: 'timestamp' }).notNull(),
  sourceFingerprint: text('source_fingerprint'),
})

// Cross-app activity feed normalised into a single timeline.
export const projectActivity = sqliteTable('project_activity', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  sourceApp: text('source_app').notNull(),  // 'slack' | 'github' | ...
  sourceKind: text('source_kind').notNull(), // 'message' | 'pr_opened' | ...
  ts: integer('ts', { mode: 'timestamp' }).notNull(),
  actor: text('actor'),
  title: text('title').notNull(),
  url: text('url'),
  payloadJson: text('payload_json', { mode: 'json' }),
  dedupeKey: text('dedupe_key').notNull(),
})

// Time-series KPI samples for sparklines/trends.
export const projectMetrics = sqliteTable('project_metrics', {
  projectId: text('project_id').notNull(),
  metricKey: text('metric_key').notNull(), // 'open_prs' | 'open_p1' | 'velocity' | ...
  ts: integer('ts', { mode: 'timestamp' }).notNull(),
  value: integer('value').notNull(),
  unit: text('unit'),
})

export const projectDecisions = sqliteTable('project_decisions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  decidedAt: integer('decided_at', { mode: 'timestamp' }).notNull(),
  decidedBy: text('decided_by'),
  linkedActivityId: text('linked_activity_id'),
})

export const projectRisks = sqliteTable('project_risks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  severity: text('severity').notNull().default('medium'), // ProjectRiskLevel
  status: text('status').notNull().default('open'),       // 'open' | 'mitigating' | 'resolved' | 'accepted'
  owner: text('owner'),
  mitigation: text('mitigation'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
})
