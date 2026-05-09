import { getProvider } from '../providers'
import { executeTools } from '../tools'
import type { ConversationMessage, StreamEvent } from '../providers/types'
import { canUseTool, PermissionStore } from './permissions'
import type { AgentMode } from './permissions'
import { listConnections, listAvailableApps, getApp } from '../apps/manager'
import { getAllSnapshots } from '../context/snapshotManager'
import { estimateConversationTokens } from '../context/tokenCounter'
import { pruneHistory, summarizeHistory } from '../context/compaction'
import { getContextWindow } from '../../../src/lib/modelCapabilities'
import { analyzeIntent, extractToolGroups, matchPluginTriggers } from './intentEngine'
import { BASE_SYSTEM_PROMPT, buildPlanModePrompt, buildYoloModePrompt } from '../training/orchestration/prompt.ts'
import fs from 'node:fs'

// ─── E2E Agent Stub ──────────────────────────────────────────────────────────
// When WOS_E2E_AGENT_SCRIPT is set, scripted turns are replayed instead of
// calling the real LLM. Script JSON format:
//   { "turns": [ [StreamEvent, ...], [StreamEvent, ...], ... ] }
// Turns are consumed globally in order across all queryLoop instances.
// Reset by setting __wos_stub_reset = true on globalThis (the harness does
// this between tests by re-launching the Electron process, so no manual
// reset is needed in production).

let _stubTurns: StreamEvent[][] | null = null
let _stubTurnIndex = 0

function loadStubScript(): void {
  const scriptPath = process.env.WOS_E2E_AGENT_SCRIPT
  if (!scriptPath) return
  if (_stubTurns !== null) return
  try {
    const raw = fs.readFileSync(scriptPath, 'utf8')
    const parsed = JSON.parse(raw) as { turns?: unknown }
    _stubTurns = (parsed.turns ?? []) as StreamEvent[][]
    _stubTurnIndex = 0
    console.log(`[stub] loaded ${_stubTurns.length} scripted turns from ${scriptPath}`)
  } catch (err) {
    console.error('[stub] failed to load agent script:', err)
    _stubTurns = []
  }
}

async function* stubStream(): AsyncGenerator<StreamEvent> {
  if (_stubTurns === null) loadStubScript()
  const turns = _stubTurns!
  const idx = _stubTurnIndex++
  const events: StreamEvent[] = turns[idx] ?? [
    { type: 'text_delta', content: `[E2E stub: no scripted turn at index ${idx}]` } as StreamEvent,
    { type: 'message_stop', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } } as StreamEvent,
  ]
  for (const event of events) {
    yield event
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_preparing'; toolName: string; toolId: string }
  | { type: 'tool_arg_delta'; toolId: string; delta: string }
  | { type: 'tool_stdout_delta'; toolId: string; delta: string }
  | { type: 'tool_stderr_delta'; toolId: string; delta: string }
  | { type: 'tool_use_start'; toolName: string; toolId: string; input: unknown }
  | { type: 'tool_result'; toolId: string; result: unknown; error?: string }
  | { type: 'subagent_start'; agentId: string; agentName: string; colorSeed: number; prompt: string }
  | { type: 'subagent_event'; agentId: string; agentName: string; colorSeed: number; event: AgentEvent }
  | { type: 'subagent_end'; agentId: string; agentName: string; colorSeed: number; result: string }
  | { type: 'subagent_focus'; agentId: string | null }
  | { type: 'permission_request'; toolName: string; toolId: string; args: unknown }
  | { type: 'permission_decided'; toolId: string; decision: 'allowed' | 'denied' }
  | { type: 'ask_user'; question: string; questionId: string; choices?: string[]; extras?: import('../../../src/types').AskUserExtras }
  | { type: 'ask_user_answered'; questionId: string; answer: string }
  | { type: 'plan_ready' }
  | { type: 'turn_start' }
  | { type: 'turn_complete'; usage: { inputTokens: number; outputTokens: number }; reason?: 'end_turn' | 'tool_use' | 'aborted' | 'error' }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'compact_started' }
  | { type: 'compact_complete'; summary: string }

export interface QueryOptions {
  model: string
  messages: ConversationMessage[]
  userMessage: string
  workspacePath: string | null
  mode: AgentMode
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  signal?: AbortSignal
  permissionStore: PermissionStore
  onPermissionRequest: (toolName: string, toolId: string, args: unknown) => Promise<'allow' | 'allow-session' | 'deny'>
  onAskUser: (question: string, questionId: string, choices?: string[], extras?: import('../../../src/types').AskUserExtras) => Promise<string>
  maxDepth?: number
  /** Priority stack (applied in order: override REPLACES base; others append). */
  systemPromptOverride?: string
  systemPromptCustom?: string
  systemPromptAppend?: string
  apiKeyOverride?: string
  /** Direct callback for side-channel events (tool_stdout_delta, etc.) that
   * tools emit during execute() — these are pushed out-of-band with yielded events. */
  onEvent?: (event: AgentEvent) => void
  /** Identifies which agent definition is running. Drives tool curation
   * (e.g. "meeting" sees a curated subset) and system-prompt augmentation.
   * Defaults to "wos". */
  agentKey?: string
  /** Conversation id, forwarded to ToolContext so tools (e.g. Task subagent)
   * can persist ledger rows scoped to the right conversation. */
  conversationId?: string
  /** Context window limit for this model. Used to trigger auto-compaction. */
  contextLimit?: number
  /** Model to use for intent classification pre-call. Defaults to claude-haiku-4-5-20251001. */
  intentModel?: string
  /** When true, skip the intent pre-call (subagents, plan mode, etc.). */
  skipIntent?: boolean
  /**
   * Model to use for conversational/analytical requests that need no tools.
   * When the intent classifier marks a request as conversational and the primary
   * model is a specialist fine-tuned model (e.g. hfspace:*), this model handles
   * the response instead — avoiding the specialist model's tool-calling bias.
   * Defaults to 'claude-haiku-4-5-20251001'.
   */
  conversationalModel?: string
}

/**
 * Build a compact "Connected Apps" section for injection into system prompts.
 * Lists only metadata (app name, tool count, snapshot scopes) — no actual data values.
 * Deterministic ordering (sorted by appId) to avoid prompt-cache busting.
 */
function buildConnectedAppsSection(): string {
  try {
    const connections = listConnections().filter(c => c.enabled)
    if (connections.length === 0) return ''

    const manifests = listAvailableApps()
    const nameMap: Record<string, string> = {}
    for (const m of manifests) nameMap[m.id] = m.name

    const snapshots = getAllSnapshots()
    const scopesByApp: Record<string, string[]> = {}
    for (const s of snapshots) {
      scopesByApp[s.appId] = [...(scopesByApp[s.appId] ?? []), s.scope]
    }

    const sorted = [...connections].sort((a, b) => a.appId.localeCompare(b.appId))
    const lines = sorted.map(c => {
      const name = nameMap[c.appId] ?? c.appId
      let toolCount = 0
      try {
        toolCount = getApp(c.appId)?.buildTools(c.creds).length ?? 0
      } catch { /* non-fatal */ }
      const scopes = (scopesByApp[c.appId] ?? []).sort().join(', ')
      return `- ${name} (${c.appId}) — tools: ${toolCount}, scopes: {${scopes}}`
    })

    return `## Connected Apps\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT

/** Trigger compaction when estimated tokens exceed this fraction of context limit. */
const COMPACT_THRESHOLD = 0.75

function compactConnectedAppsSection(section: string): string {
  // For small-context models, the verbose Connected Apps section (tool counts + scopes)
  // can dominate the prompt. Keep only the human-readable app names.
  // Input looks like:
  // ## Connected Apps
  // - Slack (slack) — tools: 12, scopes: {...}
  const lines = section.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) { out.push(line); continue }
    if (!line.trim().startsWith('-')) continue
    const m = line.match(/^\-\s+([^\(]+)\s*\(/)
    if (m?.[1]) out.push(`- ${m[1].trim()}`)
  }
  return out.length > 1 ? out.join('\n') : section
}

function isSmallContextModel(effectiveContextLimit: number): boolean {
  // Apply small-context protections (intent-filtering, schema compression,
  // larger output headroom) for models with ≤40k token context windows.
  //
  // Why 40k? A fully-connected WOS instance (Slack 12 + GitHub 15 + Jira 14
  // + 16 builtins = 57 tools) consumes ~16 000 real tokens for tool schemas
  // alone under vLLM/Qwen3 tokenization (~2.2 chars/token for JSON).
  // Even at 32k context this leaves only ~16k for conversation history, so
  // the intent-based tool filtering and schema compression are still valuable.
  // Models with >40k context (GPT-4.1, Claude, large OpenAI models) have
  // abundant headroom and do not need the extra guardrails.
  return effectiveContextLimit <= 40_000
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function computeOutputTokenBudget(effectiveContextLimit: number, estimatedPromptTokens: number): number {
  // Reserve a safety buffer so vLLM-style servers don't reject the request.
  // For 8k models, output tokens must be significantly smaller than context.
  const reserveForOverhead = 512
  const available = effectiveContextLimit - estimatedPromptTokens - reserveForOverhead
  // Default output budget targets: 512 for small models, 2048 for larger.
  const target = effectiveContextLimit <= 10_000 ? 512 : 2048
  return clamp(Math.min(target, available), 128, target)
}

type ToolDef = { name: string; description: string; inputSchema: object }

/**
 * Trim tool descriptions to at most maxDescChars per tool.
 * Tool schemas are the dominant token consumer for small-context models.
 * A full description + parameter schema can be 200–400 tokens per tool;
 * with 30–40 connected-app tools this easily saturates an 8k context window
 * before any conversation history is included.
 */
function trimToolDescriptions(tools: ToolDef[], maxDescChars = 120): ToolDef[] {
  return tools.map(t => ({
    ...t,
    description: t.description.length > maxDescChars
      ? t.description.slice(0, maxDescChars).replace(/\s\S*$/, '') + '…'
      : t.description,
  }))
}

/**
 * Remove per-parameter description strings from tool input schemas.
 * Preserves type, enum, required, and other structural fields so the
 * model can still form valid arguments; only strips free-text descriptions
 * that inflate token count without affecting call structure.
 */
function stripParamDescriptions(tools: ToolDef[]): ToolDef[] {
  return tools.map(t => {
    if (!t.inputSchema || typeof t.inputSchema !== 'object') return t
    const schema = t.inputSchema as Record<string, unknown>
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!props) return t
    const stripped: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of Object.entries(props)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { description: _d, ...rest } = v
      stripped[k] = rest
    }
    return { ...t, inputSchema: { ...schema, properties: stripped } }
  })
}

/**
 * Progressively compress tool schemas until the estimated token count fits
 * within the context ceiling. Applied only for small-context models.
 *
 * Rounds:
 *  1. Truncate tool descriptions to ~120 chars each          (~20–30% reduction)
 *  2. Strip per-parameter description strings                (~further 20%)
 *  3. Keep only intent-matched + ALWAYS_INCLUDE tools        (~50% reduction)
 *  4. Keep only ALWAYS_INCLUDE builtins (last resort)
 */
function enforceTokenCeiling(
  tools: ToolDef[],
  systemPrompt: string,
  history: import('../providers/types').ConversationMessage[],
  ceiling: number,
  alwaysInclude: Set<string>,
  intentFilter: string[],
): ToolDef[] {
  const fits = (ts: ToolDef[]) =>
    estimateConversationTokens(history, systemPrompt, ts) <= ceiling

  if (fits(tools)) return tools

  const step1 = trimToolDescriptions(tools)
  if (fits(step1)) return step1

  const step2 = stripParamDescriptions(step1)
  if (fits(step2)) return step2

  const step3 = step2.filter(
    t => alwaysInclude.has(t.name) || intentFilter.includes(t.name),
  )
  if (fits(step3)) return step3

  // Last resort: builtins only — model can still clarify or delegate.
  return step2.filter(t => alwaysInclude.has(t.name))
}

export async function* queryLoop(options: QueryOptions): AsyncGenerator<AgentEvent> {
  const {
    model, messages, userMessage, workspacePath, mode, reasoningEffort,
    signal, permissionStore, onPermissionRequest, onAskUser, maxDepth = 0,
    systemPromptOverride, systemPromptCustom, systemPromptAppend, apiKeyOverride, onEvent,
    agentKey, conversationId, contextLimit, intentModel, skipIntent, conversationalModel,
  } = options

  const effectiveContextLimit = contextLimit ?? getContextWindow(model) ?? 200_000
  const smallCtx = isSmallContextModel(effectiveContextLimit)

  // Run intent analysis once per queryLoop to determine which tools to include.
  // Skip for subagents (maxDepth > 0), plan mode, and when explicitly disabled.
  let intentToolFilter: string[] = []
  // When true, the request is conversational/analytical — call the model with NO tools
  // so the fine-tuned model's tool-calling bias cannot fire for non-tool requests.
  let conversationalRequest = false
  if (!skipIntent && maxDepth === 0 && mode !== 'plan' && !process.env.WOS_E2E_AGENT_SCRIPT) {
    try {
      const { getAllTools: _getAllToolsForIntent } = await import('../tools')
      const allToolNames = _getAllToolsForIntent().map(t => t.name)
      const groups = extractToolGroups(allToolNames)
      if (groups.length > 0) {
        const effectiveIntentModel = intentModel ?? 'claude-haiku-4-5-20251001'
        const intent = await analyzeIntent(
          userMessage, groups, effectiveIntentModel, apiKeyOverride, signal
        )

        if (intent.conversational) {
          // Purely conversational/analytical — strip all tools so the model cannot
          // hallucinate tool calls (e.g. calling GitHubListRepos for "explain this codebase").
          conversationalRequest = true
        } else {
          // Accept lower confidence for small-context models so the intent filter
          // fires more reliably. On an 8k context budget, injecting all tool schemas
          // without filtering is the single largest cause of context overflow.
          const intentThreshold = smallCtx ? 0.4 : 0.6
          if (intent.confidence >= intentThreshold && intent.toolFilter.length > 0) {
            intentToolFilter = intent.toolFilter
            // Also add tools from plugins whose trigger keywords appear in the message
            const { getPluginTriggerMap } = await import('../plugins/loader')
            const triggerMap = getPluginTriggerMap()
            if (triggerMap.size > 0) {
              const matchedPluginIds = matchPluginTriggers(userMessage, triggerMap)
              if (matchedPluginIds.length > 0) {
                // Include all tools belonging to matched plugins
                const pluginToolNames = allToolNames.filter(name =>
                  matchedPluginIds.some(pid => name.startsWith(`${pid}__`))
                )
                intentToolFilter = [...new Set([...intentToolFilter, ...pluginToolNames])]
              }
            }
          }
        }
      }
    } catch {
      // Intent analysis failure is non-fatal; fall through to use all tools
    }
  }
  const { getAgentDef } = await import('./agentDefs')
  const agentDef = getAgentDef(agentKey ?? 'wos')

  // effectiveMode may change mid-run when the user approves a plan in yolo/default mode.
  let effectiveMode: AgentMode = mode

  // Model routing: when the intent classifier marks the request as conversational and
  // the caller is using a specialist fine-tuned model (hfspace:*), route to a capable
  // general-purpose model instead. The specialist model was trained overwhelmingly on
  // tool-calling examples; asking it a conversational question even with no tools
  // produces poor results (confabulation, looping). Routing avoids this entirely
  // without any retraining.
  //
  // Preferred fallback: the base Qwen3-32B on the same HF Space (USE_LORA=1 mode lets
  // vLLM serve both the base model and the wos-orch LoRA adapter on one endpoint).
  // This avoids burning Claude credits and keeps responses in the same domain.
  // Secondary fallback: conversationalModel option, then claude-haiku.
  const isSpecialistModel = model.startsWith('hfspace:')
  let activeModel = model
  if (conversationalRequest && isSpecialistModel) {
    if (conversationalModel) {
      activeModel = conversationalModel
    } else {
      // Derive the base model ID on the same Space by replacing the fine-tuned
      // model name (wos-orch / merged) with the base Qwen3-32B identifier.
      // Works when the Space runs in USE_LORA=1 mode (vLLM serves both).
      try {
        const { decodeHuggingFaceSpaceModelId, encodeHuggingFaceSpaceModelId } = await import('../providers/huggingfaceSpaces')
        const decoded = decodeHuggingFaceSpaceModelId(model)
        if (decoded) {
          // Route to the base model on the same Space endpoint.
          activeModel = encodeHuggingFaceSpaceModelId(decoded.spaceId, 'unsloth/Qwen3-32B-bnb-4bit')
        } else {
          activeModel = 'claude-haiku-4-5-20251001'
        }
      } catch {
        activeModel = 'claude-haiku-4-5-20251001'
      }
    }
  }

  const provider = getProvider(activeModel)

  // Pull rules + skills prompt sections (cheap — just reads from DB).
  let rulesSection = ''
  let skillsSection = ''
  try {
    const { buildRulesPromptSection } = await import('../rules/manager')
    const { buildSkillIndex } = await import('../skills/manager')
    rulesSection = buildRulesPromptSection(null)
    skillsSection = buildSkillIndex()
  } catch (err) {
    // Skills/rules managers may not be initialised during early tests — non-fatal.
    if (process.env.WOS_DEBUG === '1') console.warn('[query] rules/skills load failed', err)
  }

  // Build the connected-apps awareness section once per turn (deterministic, sorted).
  const connectedAppsSectionRaw = buildConnectedAppsSection()
  const connectedAppsSection = smallCtx && connectedAppsSectionRaw
    ? compactConnectedAppsSection(connectedAppsSectionRaw)
    : connectedAppsSectionRaw

  // Priority stack: override > (base + mode + workspace + rules + skills + custom) > append
  let systemPrompt: string
  if (systemPromptOverride) {
    // Prepend connected-apps section so subagents with custom prompts still get app awareness.
    systemPrompt = connectedAppsSection
      ? `${connectedAppsSection}\n\n${systemPromptOverride}`
      : systemPromptOverride
  } else {
    systemPrompt = SYSTEM_PROMPT
    if (connectedAppsSection) systemPrompt = `${connectedAppsSection}\n\n${systemPrompt}`
    if (mode === 'plan') systemPrompt = buildPlanModePrompt(systemPrompt)
    if (mode === 'yolo') systemPrompt = buildYoloModePrompt(systemPrompt)
    // For small-context models (e.g. HF Space vLLM 8k), these sections can easily
    // overwhelm the context budget and cause hard 400s even on short user messages.
    // Keep core policy and connected-app awareness, but drop optional expansions.
    if (!smallCtx) {
      if (workspacePath) systemPrompt += `\n\n## Workspace\nCurrent workspace: ${workspacePath}`
      if (rulesSection) systemPrompt += `\n\n${rulesSection}`
      if (skillsSection) systemPrompt += `\n\n${skillsSection}`
    }
    if (systemPromptCustom) systemPrompt += `\n\n## Custom Instructions\n${systemPromptCustom}`
    if (agentDef?.systemPrompt) systemPrompt += `\n${agentDef.systemPrompt}`
  }
  if (systemPromptAppend) systemPrompt += `\n\n${systemPromptAppend}`

  const history: ConversationMessage[] = [...messages]

  // Add user message to history
  history.push({ role: 'user', content: userMessage })

  let planApproved = false
  let turnStarted = false

  while (true) {
    if (signal?.aborted) return

    const { getAllTools } = await import('../tools')
    const allToolsRaw = getAllTools()
    const allTools = agentDef ? agentDef.toolFilter(allToolsRaw) : allToolsRaw

    // Apply intent-based tool filter when available and confident enough.
    // Always include builtin tools regardless of filter (they are safe defaults).
    const ALWAYS_INCLUDE = new Set([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
      'WebFetch', 'WebSearch', 'Task', 'AskUser', 'TodoWrite',
      'EnterPlanMode', 'ExitPlanMode', 'ReadSkill', 'ReadAppSkill', 'ReadRule',
    ])

    // For conversational/analytical requests, restrict to a safe general-purpose tool set.
    // Workplace-app tools (Slack, GitHub, Jira, etc.) are excluded — those are for the
    // specialist model and would trigger hallucinated tool calls on any model without
    // fine-tuned tool-calling discipline.
    // WebSearch/WebFetch are kept so the model can answer research questions.
    // AskUser is kept for clarifications. Task is kept for delegation.
    const CONVERSATIONAL_TOOLS = new Set([
      'WebSearch', 'WebFetch', 'AskUser', 'Task', 'TodoWrite',
    ])
    type RuntimeTool = (typeof allTools)[number]

    let filteredTools: RuntimeTool[] = conversationalRequest
      ? allTools.filter(t => CONVERSATIONAL_TOOLS.has(t.name))
      : intentToolFilter.length > 0
        ? allTools.filter(t => ALWAYS_INCLUDE.has(t.name) || intentToolFilter.includes(t.name))
        : allTools

    // Small-context guardrail: if we didn't get a confident intent filter, avoid sending
    // *every* tool schema to the model (tool schemas count toward context in most servers).
    // Prefer connected-app tools + core builtins as a safe default.
    // NOTE: intentToolFilter is empty when intent confidence fell below threshold.
    // For small-context models we accept lower confidence (0.4 vs 0.6) so the
    // filter fires more reliably instead of falling back to all tools.
    if (!conversationalRequest && smallCtx && intentToolFilter.length === 0) {
      filteredTools = allTools.filter(t =>
        ALWAYS_INCLUDE.has(t.name) ||
        t.name.startsWith('Slack') ||
        t.name.startsWith('GitHub') ||
        t.name.startsWith('Jira') ||
        t.name.startsWith('Google') ||
        t.name.startsWith('Gmail') ||
        t.name.startsWith('automation_') ||
        t.name.startsWith('wos_projects_')
      )
    }

    // Absolute cap for tiny-context models to avoid pathological prompts.
    if (smallCtx && filteredTools.length > 80) {
      const keep = new Map<string, RuntimeTool>(filteredTools.map(t => [t.name, t]))
      const coreOrder = [...ALWAYS_INCLUDE]
      const out: RuntimeTool[] = []
      for (const name of coreOrder) {
        const t = keep.get(name)
        if (t) out.push(t)
      }
      for (const t of filteredTools) {
        if (out.length >= 80) break
        if (!out.includes(t)) out.push(t)
      }
      filteredTools = out
    }

    let toolDefs: ToolDef[] = (maxDepth > 0
      ? filteredTools.filter(t => t.name !== 'Task') // No recursive subagents
      : filteredTools
    ).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))

    // ── Small-context pre-flight enforcement ──────────────────────────────────
    // Tool schemas are the dominant token consumer: 30–40 connected-app tools
    // with verbose parameter descriptions can consume 5 000–7 000 tokens,
    // leaving no room for conversation history or output on an 8k model.
    // Apply progressive schema compression *before* the API call so the request
    // never arrives with more input tokens than the server can accept.
    // For small-context models (≤10k tokens), reserve 1500 tokens instead of 768.
    // The extra headroom absorbs token-estimator inaccuracy for JSON schema content
    // (real tokenizer runs ~20-30% hotter than our 4-char/token heuristic).
    // This means the enforceTokenCeiling ceiling is 8192-1500=6692 on an 8k model,
    // giving reliable headroom before vLLM rejects the request with a 400.
    const minOutputHeadroom = smallCtx ? 1500 : 2048
    if (smallCtx) {
      const ceiling = effectiveContextLimit - minOutputHeadroom
      toolDefs = enforceTokenCeiling(
        toolDefs, systemPrompt, history, ceiling, ALWAYS_INCLUDE, intentToolFilter,
      )
    }

    // Auto-compact if estimated token count exceeds COMPACT_THRESHOLD of context limit.
    // Skip compaction for subagents (maxDepth > 0) and E2E stubs to keep those simple.
    if (!process.env.WOS_E2E_AGENT_SCRIPT && maxDepth === 0) {
      let estimated = estimateConversationTokens(history, systemPrompt, toolDefs)

      // Hard guardrail: ensure we leave headroom for output tokens.
      const mustCompact = estimated > effectiveContextLimit - minOutputHeadroom

      // mustCompact fires even on short histories (fresh single-turn conversations
      // can still overflow if the system prompt + tool schemas are large).
      // The softer COMPACT_THRESHOLD path requires history.length > 4 to avoid
      // needlessly compacting brand-new conversations on capable models.
      if (mustCompact || (estimated > effectiveContextLimit * COMPACT_THRESHOLD && history.length > 4)) {
        yield { type: 'compact_started' }
        try {
          // Try pruning first (fast, no API call). If still over threshold, summarize.
          const { pruned } = pruneHistory(history)
          let afterPrune = estimateConversationTokens(pruned, systemPrompt, toolDefs)
          const pruneOk = smallCtx
            ? (afterPrune <= effectiveContextLimit - minOutputHeadroom)
            : (afterPrune <= effectiveContextLimit * COMPACT_THRESHOLD)

          if (pruneOk) {
            history.length = 0
            history.push(...pruned)
            yield { type: 'compact_complete', summary: `Pruned ${history.length - pruned.length} old messages to stay within context limit.` }
          } else {
            const abortSignal = signal ?? new AbortController().signal
            const { summarized, summary } = await summarizeHistory(history, activeModel, abortSignal, apiKeyOverride)
            history.length = 0
            history.push(...summarized)
            yield { type: 'compact_complete', summary }
          }
        } catch {
          // Compaction failure is non-fatal — continue with original history
          yield { type: 'compact_complete', summary: 'Context compaction skipped.' }
        }
      }
    }

    // E2E: use scripted stub instead of a real LLM call when configured.
    const stream = process.env.WOS_E2E_AGENT_SCRIPT
      ? stubStream()
      : provider.stream({
          model: activeModel,
          messages: history,
          tools: toolDefs,
          systemPrompt,
          reasoningEffort,
          apiKeyOverride,
          signal,
          // Keep output budget proportional to context window.
          maxTokens: computeOutputTokenBudget(
            effectiveContextLimit,
            estimateConversationTokens(history, systemPrompt, toolDefs),
          ),
        })

    if (!turnStarted) {
      turnStarted = true
      yield { type: 'turn_start' }
    }

    const pendingToolCalls: Array<{ id: string; name: string; input: unknown }> = []
    let hasText = false
    let accumulatedText = ''
    let planExitRequested: { id: string; plan: string } | null = null

    for await (const event of stream) {
      if (signal?.aborted) return

      switch (event.type) {
        case 'text_delta': {
          // In plan mode, stream text normally; plan finalisation is triggered
          // by the agent calling ExitPlanMode rather than by a text sentinel.
          yield { type: 'text_delta', content: event.content }
          hasText = true
          accumulatedText += event.content
          break
        }

        case 'thinking_delta':
          yield { type: 'reasoning_delta', content: event.content }
          break

        case 'tool_preparing':
          yield { type: 'tool_preparing', toolName: event.name, toolId: event.id }
          break

        case 'tool_arg_delta':
          yield { type: 'tool_arg_delta', toolId: event.id, delta: event.delta }
          break

        case 'tool_use_start':
          // ExitPlanMode is intercepted — we pause for user approval instead of running it.
          if (event.name === 'ExitPlanMode' && mode === 'plan' && !planApproved) {
            const input = (event.input ?? {}) as { plan?: string }
            planExitRequested = { id: event.id, plan: input.plan ?? '' }
            break
          }
          // EnterPlanMode: acknowledge with a synthetic result so the model continues.
          if (event.name === 'EnterPlanMode') {
            yield { type: 'tool_use_start', toolName: event.name, toolId: event.id, input: event.input }
            if (mode === 'plan' && !planApproved) {
              yield { type: 'tool_result', toolId: event.id, result: 'already_in_plan_mode' }
            } else {
              planApproved = false
              yield { type: 'tool_result', toolId: event.id, result: 'entered_plan_mode' }
              yield { type: 'plan_ready' }
            }
            break
          }
          // All other tools (including read-only tools used during plan-mode research)
          // are yielded and tracked for execution so the multi-turn loop stays correct.
          yield { type: 'tool_use_start', toolName: event.name, toolId: event.id, input: event.input }
          pendingToolCalls.push({ id: event.id, name: event.name, input: event.input })
          break

        case 'message_stop': {
          // In plan mode: if the model ended the turn with text but never called
          // ExitPlanMode, synthesise a plan-exit so the approval UI fires anyway.
          if (
            mode === 'plan' && !planApproved && hasText &&
            !planExitRequested && pendingToolCalls.length === 0
          ) {
            planExitRequested = {
              id: `synthetic-plan-${Date.now()}`,
              plan: accumulatedText.trim(),
            }
            break
          }
          if ((event.stopReason === 'end_turn' || pendingToolCalls.length === 0) && !planExitRequested) {
            yield {
              type: 'turn_complete',
              usage: event.usage,
              reason: event.stopReason === 'end_turn' ? 'end_turn' : 'tool_use',
            }
            return
          }
          break
        }
      }
    }

    // Plan-mode approval gate: if the agent called ExitPlanMode (or wrote a text
    // plan without calling the tool), pause and ask the user what to do.
    if (planExitRequested) {
      const exit = planExitRequested
      // Detect synthetic exits (model wrote text but did not call ExitPlanMode tool).
      const isSynthetic = exit.id.startsWith('synthetic-plan-')
      yield { type: 'plan_ready' }
      // Embed the plan markdown so the renderer can show it in the approval block.
      // Format: `__plan_approval__\n\n<plan markdown>`
      const planQuestion = `__plan_approval__\n\n${exit.plan ?? ''}`
      const decision = await onAskUser(
        planQuestion,
        exit.id,
        ['approve_default', 'approve_yolo', 'save', 'suggest']
      )
      // Decision values:
      //   approve | approve_default → run with default permissions
      //   approve_yolo              → run with yolo permissions (auto-approve all tools)
      //   save                      → save plan to workspace and end the run
      //   suggest:<feedback>        → reject with feedback, agent revises
      if (decision === 'approve' || decision === 'approve_default' || decision === 'approve_yolo') {
        planApproved = true
        if (decision === 'approve_yolo') effectiveMode = 'yolo'
        else if (decision === 'approve_default') effectiveMode = 'default'
        // Rebuild system prompt for the approved execution mode (strip plan-mode instructions)
        if (!systemPromptOverride) {
          systemPrompt = SYSTEM_PROMPT
          if (connectedAppsSection) systemPrompt = `${connectedAppsSection}\n\n${systemPrompt}`
          if (effectiveMode === 'yolo') systemPrompt = buildYoloModePrompt(systemPrompt)
          if (workspacePath) systemPrompt += `\n\n## Workspace\nCurrent workspace: ${workspacePath}`
          if (rulesSection) systemPrompt += `\n\n${rulesSection}`
          if (skillsSection) systemPrompt += `\n\n${skillsSection}`
          if (systemPromptCustom) systemPrompt += `\n\n## Custom Instructions\n${systemPromptCustom}`
          if (agentDef?.systemPrompt) systemPrompt += `\n${agentDef.systemPrompt}`
          if (systemPromptAppend) systemPrompt += `\n\n${systemPromptAppend}`
        }
        if (isSynthetic) {
          // The model wrote text — just inject a user turn to proceed.
          history.push({ role: 'user', content: 'Plan approved. Please proceed to execute the plan.' })
        } else {
          history.push({
            role: 'assistant',
            content: [
              { type: 'tool_use', id: exit.id, name: 'ExitPlanMode', input: { plan: exit.plan } },
            ],
          })
          history.push({
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: exit.id, content: 'Plan approved. Proceed to execute.' },
            ],
          })
        }
        continue
      } else if (decision.startsWith('save')) {
        // User chose to save plan and exit. The renderer is responsible for the
        // actual file write (it has workspace context via IPC); we just end here.
        if (!isSynthetic) {
          history.push({
            role: 'assistant',
            content: [
              { type: 'tool_use', id: exit.id, name: 'ExitPlanMode', input: { plan: exit.plan } },
            ],
          })
          history.push({
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: exit.id, content: 'Plan saved by user. Ending run.' },
            ],
          })
        }
        yield { type: 'turn_complete', usage: { inputTokens: 0, outputTokens: 0 }, reason: 'end_turn' }
        return
      } else {
        // suggest:<feedback>  OR  reject (legacy)
        const feedback = decision.startsWith('suggest:')
          ? decision.slice('suggest:'.length).trim()
          : ''
        const rejectMsg = feedback
          ? `Plan rejected. User feedback: ${feedback}\n\nPlease revise the plan and propose a new one.`
          : 'Plan rejected. Please revise and propose a new plan.'
        if (isSynthetic) {
          history.push({ role: 'user', content: rejectMsg })
        } else {
          history.push({
            role: 'assistant',
            content: [
              { type: 'tool_use', id: exit.id, name: 'ExitPlanMode', input: { plan: exit.plan } },
            ],
          })
          history.push({
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: exit.id, content: rejectMsg },
            ],
          })
        }
        continue
      }
    }

    if (pendingToolCalls.length === 0) {
      return
    }

    // Phase 1: resolve permissions sequentially (they may prompt the user).
    type PermDecision = { call: { id: string; name: string; input: unknown }; granted: boolean; error?: string }
    const permDecisions: PermDecision[] = []
    for (const call of pendingToolCalls) {
      if (signal?.aborted) return

      const permission = await canUseTool(call.name, effectiveMode, permissionStore, call.input)

      if (permission.decision === 'deny') {
        permDecisions.push({ call, granted: false, error: permission.reason ?? 'Blocked by policy' })
        continue
      }

      if (permission.decision === 'request') {
        const decision = await onPermissionRequest(call.name, call.id, call.input)
        if (decision === 'deny') {
          permDecisions.push({ call, granted: false, error: 'Permission denied by user' })
          continue
        }
        if (decision === 'allow-session') {
          permissionStore.addSessionGrant(call.name)
        }
      }

      permDecisions.push({ call, granted: true })
    }

    // Phase 2: execute all permitted tools concurrently.
    // Subagent events flow through ctx.yieldEvent → onEvent immediately as they
    // arrive, giving true interleaving. tool_result yields happen after all settle.
    const toolResultMap = new Map<string, { output: unknown; error?: string }>()

    await Promise.all(
      permDecisions.map(async ({ call, granted, error }) => {
        if (!granted) {
          toolResultMap.set(call.id, { output: null, error })
          return
        }
        try {
          const result = await executeTools(
            call.name,
            call.input,
            {
              workspacePath,
              signal: signal ?? new AbortController().signal,
              yieldEvent: (e: AgentEvent) => {
                // Side-channel: forward directly to runner-level emit.
                if (onEvent) onEvent(e)
              },
              onPermissionRequest,
              onAskUser,
              toolId: call.id,
              parentMessages: history,
              parentModel: model,
              parentMode: mode,
              parentReasoningEffort: reasoningEffort,
              parentApiKeyOverride: apiKeyOverride,
              conversationId,
              extras: { subagentDepth: maxDepth },
            }
          )
          toolResultMap.set(call.id, { output: result.output })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          toolResultMap.set(call.id, { output: null, error: msg })
        }
      })
    )

    // Phase 3: yield tool_results in the original call order, build history.
    const toolResults: Array<{ id: string; name: string; output: unknown; error?: string }> = []
    for (const { call } of permDecisions) {
      const r = toolResultMap.get(call.id) ?? { output: null, error: 'internal: result missing' }
      toolResults.push({ id: call.id, name: call.name, output: r.output, error: r.error })
      if (r.error) {
        yield { type: 'tool_result', toolId: call.id, result: null, error: r.error }
      } else {
        yield { type: 'tool_result', toolId: call.id, result: r.output }
      }
    }

    // Build tool result messages for next iteration
    const assistantContent = pendingToolCalls.map(tc => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }))

    history.push({ role: 'assistant', content: assistantContent as never })
    history.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.error ? `Error: ${r.error}` : JSON.stringify(r.output),
      })) as never,
    })
  }
}
