import { ipcMain } from 'electron'
import { registry, type AutomationKind, type ResultDelivery } from '../automations/registry'
import { audit } from '../automations/audit'
import { runAutomation } from '../automations/runner'
import { automationsRuntime } from '../automations'
import { ensureWebhook } from '../automations/webhooks'
import { answerQuestion, listPending } from '../automations/questions'
import { refreshTrayMenu } from '../tray'
import { listConnections, listAvailableApps } from '../apps/manager'
import { getSnapshot } from '../context/snapshotManager'
import { resolveAgent, resolveApiKeyForModel } from '../agent/settings'

import { getProvider } from '../providers'

// Placeholder keys that map to specific app snapshot scopes
const PLACEHOLDER_TO_SNAPSHOT: Record<string, { appId: string; scope: string; labelField: string; idField: string }> = {
  'CHANNEL': { appId: 'slack', scope: 'channels', labelField: 'name', idField: 'id' },
  'CHANNEL_NAME': { appId: 'slack', scope: 'channels', labelField: 'name', idField: 'id' },
  'SLACK_CHANNEL': { appId: 'slack', scope: 'channels', labelField: 'name', idField: 'id' },
  'REPO': { appId: 'github', scope: 'repos', labelField: 'full_name', idField: 'name' },
  'REPO_NAME': { appId: 'github', scope: 'repos', labelField: 'full_name', idField: 'name' },
  'GITHUB_REPO': { appId: 'github', scope: 'repos', labelField: 'full_name', idField: 'name' },
  'PROJECT': { appId: 'jira', scope: 'projects', labelField: 'name', idField: 'key' },
  'PROJECT_KEY': { appId: 'jira', scope: 'projects', labelField: 'name', idField: 'key' },
  'CALENDAR': { appId: 'google', scope: 'calendars', labelField: 'summary', idField: 'id' },
  'CALENDAR_NAME': { appId: 'google', scope: 'calendars', labelField: 'summary', idField: 'id' },
}

interface ClarificationQuestion {
  key: string
  question: string
  kind: 'choice' | 'text'
  choices?: Array<{ id: string; label: string; description?: string; value: string }>
  placeholder: string
  allowFreeform: boolean
}

interface MissingApp { appId: string; name: string }

// Detect [PLACEHOLDER] markers in a prompt string
function extractPlaceholders(prompt: string): string[] {
  const matches = prompt.matchAll(/\[([A-Z][A-Z0-9_]*)\]/g)
  return [...new Set([...matches].map(m => m[1]))]
}

// Build clarification questions from detected placeholders + snapshot data
async function buildClarifications(
  prompt: string,
  connectedIds: Set<string>,
  appById: Map<string, { id: string; name: string }>,
): Promise<{ clarifications: ClarificationQuestion[]; missingApps: MissingApp[] }> {
  const placeholders = extractPlaceholders(prompt)
  const clarifications: ClarificationQuestion[] = []
  const missingAppsMap = new Map<string, MissingApp>()

  for (const key of placeholders) {
    const mapping = PLACEHOLDER_TO_SNAPSHOT[key]

    if (!mapping) {
      // Unknown placeholder type — render as free-form text input
      clarifications.push({
        key,
        question: `What should "${key.replace(/_/g, ' ').toLowerCase()}" be?`,
        kind: 'text',
        placeholder: `[${key}]`,
        allowFreeform: true,
      })
      continue
    }

    if (!connectedIds.has(mapping.appId)) {
      // App not connected — add to missing, still allow text input
      const appName = appById.get(mapping.appId)?.name ?? mapping.appId
      missingAppsMap.set(mapping.appId, { appId: mapping.appId, name: appName })
      clarifications.push({
        key,
        question: `Which ${mapping.scope.slice(0, -1)} should be used? (Connect ${appName} first for suggestions)`,
        kind: 'text',
        placeholder: `[${key}]`,
        allowFreeform: true,
      })
      continue
    }

    // App connected — fetch snapshot data for choices
    const snapshot = getSnapshot(mapping.appId, mapping.scope)
    const data = snapshot?.data ?? []

    const choices = data.slice(0, 20).map(item => {
      const obj = item as Record<string, unknown>
      const label = String(obj[mapping.labelField] ?? obj.name ?? obj.id ?? item)
      const id = String(obj[mapping.idField] ?? obj.id ?? label)
      const members = obj.num_members != null ? `${obj.num_members} members` : undefined
      const description = members ?? (obj.description ? String(obj.description).slice(0, 60) : undefined)
      return { id, label: label.startsWith('#') ? label : `#${label}`.replace(/^##/, '#'), description, value: label }
    })

    const humanScope = mapping.scope.slice(0, -1) // 'channels' → 'channel'
    clarifications.push({
      key,
      question: `Which ${humanScope} should be used?`,
      kind: choices.length > 0 ? 'choice' : 'text',
      choices: choices.length > 0 ? choices : undefined,
      placeholder: `[${key}]`,
      allowFreeform: true,
    })
  }

  return { clarifications, missingApps: [...missingAppsMap.values()] }
}

function patchPromptWithAnswer(automationId: string, question: string, answer: string): boolean {
  const automation = registry.get(automationId)
  if (!automation) return false

  const matches = [...automation.prompt.matchAll(/\[([A-Z][A-Z0-9_]*)\]/g)]
  if (matches.length === 0) return false

  let target: string | null = null
  for (const m of matches) {
    const humanized = m[1].toLowerCase().replace(/_/g, ' ')
    if (question.toLowerCase().includes(humanized) || question.includes(m[1])) {
      target = m[1]
      break
    }
  }
  if (!target && matches.length === 1) target = matches[0][1]
  if (!target) return false

  const updatedPrompt = automation.prompt.replaceAll(`[${target}]`, answer)
  registry.upsert({ ...automation, prompt: updatedPrompt })
  return true
}

export function registerAutomationsHandlers(): void {
  ipcMain.handle('automations:list', (_evt, args?: { kind?: AutomationKind; enabled?: boolean }) => {
    return registry.list(args)
  })

  ipcMain.handle('automations:get', (_evt, args: { id: string }) => {
    return registry.get(args.id)
  })

  ipcMain.handle(
    'automations:upsert',
    (_evt, input: {
      id?: string
      kind: AutomationKind
      name: string
      description?: string | null
      enabled?: boolean
      prompt?: string
      toolsAllow?: string[]
      config?: Record<string, unknown>
      resultDelivery?: ResultDelivery
      resultTarget?: string | null
    }) => {
      const row = registry.upsert(input)
      automationsRuntime.reload(row.id)
      refreshTrayMenu()
      return row
    },
  )

  ipcMain.handle('automations:toggle', (_evt, args: { id: string; enabled: boolean }) => {
    const row = registry.toggle(args.id, args.enabled)
    if (row) automationsRuntime.reload(args.id)
    refreshTrayMenu()
    return row
  })

  ipcMain.handle('automations:delete', (_evt, args: { id: string }) => {
    registry.delete(args.id)
    automationsRuntime.reload(args.id)
    refreshTrayMenu()
    return { ok: true }
  })

  ipcMain.handle('automations:runNow', async (_evt, args: { id: string; dryRun?: boolean }) => {
    const a = registry.get(args.id)
    if (!a) return { ok: false, error: `Automation ${args.id} not found.` }
    const r = await runAutomation(a, { dryRun: !!args.dryRun, trigger: { kind: 'manual' } })
    return { ok: !r.error, runId: r.runId, output: r.output, error: r.error ?? null }
  })

  ipcMain.handle('automations:runs', (_evt, args?: { id?: string; limit?: number }) => {
    return audit.list(args?.id, args?.limit ?? 100)
  })

  ipcMain.handle('automations:webhookInfo', (_evt, args: { id: string }) => {
    const a = registry.get(args.id)
    if (!a || a.kind !== 'webhook') return null
    return ensureWebhook(a)
  })

  ipcMain.handle('automations:reloadAll', () => {
    automationsRuntime.reloadAll()
    refreshTrayMenu()
    return { ok: true }
  })

  // Answer a paused automation question
  ipcMain.handle('automations:answerQuestion', (_evt, args: { questionId: string; answer: string }) => {
    const pendingSnapshot = listPending().find(q => q.questionId === args.questionId)
    const ok = answerQuestion(args.questionId, args.answer)
    let promptUpdated = false
    if (ok && pendingSnapshot) {
      promptUpdated = patchPromptWithAnswer(pendingSnapshot.automationId, pendingSnapshot.question, args.answer)
    }
    return { ok, promptUpdated }
  })

  // List all tools available to automations (for ToolsSelector UI)
  ipcMain.handle('automations:listTools', async () => {
    const { getAllTools } = await import('../tools')
    const tools = getAllTools()
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      tags: (t as { tags?: string[] }).tags ?? [],
    }))
  })

  // AI diagnosis for a failed run
  ipcMain.handle('automations:diagnoseRun', async (_evt, args: { runId: string }) => {
    const run = audit.get(args.runId)
    if (!run) return { ok: false, error: 'Run not found' }

    let model = ''
    let apiKeyOverride: string | undefined
    try {
      const spec = await resolveAgent('automation')
      if (spec.model) { model = spec.model; apiKeyOverride = spec.apiKeyOverride }
    } catch { /* fall through */ }
    if (!model) {
      try {
        const spec = await resolveAgent('wos')
        model = spec.model ?? ''
        apiKeyOverride = spec.apiKeyOverride
      } catch { /* no model */ }
    }
    if (!model) return { ok: false, error: 'No model configured for diagnosis.' }

    const trigger = run.trigger as Record<string, unknown> | null
    const prompt = trigger?._prompt as string | undefined

    const systemPrompt = [
      'You are a diagnostic assistant for AI automation failures.',
      'Given an error message and tool call history, explain what went wrong in 2-3 sentences',
      'and give 1-2 concrete fix suggestions.',
      'Return ONLY valid JSON (no markdown fences):',
      '{ "explanation": "...", "suggestions": ["...", "..."], "actionType": "reconnect_app" | "edit_prompt" | "configure_model" | "other" }',
    ].join('\n')

    const diagnosisPrompt = [
      run.error ? `Error: ${run.error}` : '',
      `Tool calls: ${JSON.stringify(run.toolCalls ?? []).slice(0, 500)}`,
      prompt ? `Automation prompt: ${prompt.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n')

    try {
      const provider = getProvider(model)
      let raw = ''
      for await (const event of provider.stream({
        model,
        systemPrompt,
        messages: [{ role: 'user', content: diagnosisPrompt }],
        tools: [],
        maxTokens: 400,
        apiKeyOverride,
      })) {
        if (event.type === 'text_delta') raw += event.content
      }
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
      const result = JSON.parse(cleaned) as { explanation: string; suggestions: string[]; actionType: string }
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Enhanced parseDescription: returns spec + clarification questions + missing apps
  ipcMain.handle('automations:parseDescription', async (_evt, args: { description: string }) => {
    const { description } = args

    // Gather runtime context
    const allApps = listAvailableApps()
    const appById = new Map(allApps.map(a => [a.id, a]))
    const conns = listConnections()
    const connectedAppNames = conns.filter(c => c.enabled).map(c => appById.get(c.appId)?.name ?? c.appId)
    const allConnectedIds = new Set(conns.filter(c => c.enabled).map(c => c.appId))

    // Resolve model + API key
    let model = ''
    let apiKeyOverride: string | undefined
    try {
      const spec = await resolveAgent('automation')
      if (spec.model) { model = spec.model; apiKeyOverride = spec.apiKeyOverride }
    } catch { /* fall through */ }
    if (!model) {
      try {
        const agent = await resolveAgent('wos')
        model = agent.model ?? ''
        apiKeyOverride = agent.apiKeyOverride
      } catch { /* no model configured */ }
    }

    if (!model) {
      return { ok: false, error: 'No AI model configured. Open Settings → Agents → Automation (or WOS) and pick a model.' }
    }

    const systemPrompt = [
      'You parse natural-language automation descriptions into structured JSON specs.',
      'Connected apps available: ' + (connectedAppNames.join(', ') || 'none'),
      'Return ONLY a valid JSON object — no markdown fences, no explanation.',
      '',
      'Schema:',
      '{',
      '  "name": "short descriptive label (5 words max)",',
      '  "kind": "schedule" | "hook" | "webhook",',
      '  "summary": ["bullet describing trigger", "bullet describing what it does", "bullet describing output"],',
      '  "prompt": "...",',
      '  "schedule": { "mode": "at"|"every"|"cron", "at"?: "...", "every"?: "...", "cron"?: "...", "tz"?: "..." },',
      '  "hook": { "event": "meeting:saved" | "session:new" | "app:connected" | "app:disconnected" },',
      '  "webhook": {},',
      '  "delivery": { "kind": "chat" | "notify" | "silent" },',
      '  "requiredApps": ["slack", "github"]',
      '}',
      '',
      'THE PROMPT FIELD IS CRITICAL:',
      'The prompt is executed AS-IS by an autonomous agent with no access to this conversation.',
      'It must be a DIRECT, SELF-CONTAINED task instruction with all resources named explicitly.',
      '',
      'WRONG (these always fail):',
      '  "summarize the specified Slack channel"  ← "specified" is undefined at runtime',
      '  "review messages from the target channel"  ← "target" is undefined',
      '',
      'RIGHT (use actual names from the user description):',
      '  "Read the last 24 hours of messages from #all-agent-testing on Slack. Summarize the key discussions..."',
      '',
      'If the user specified a channel/repo/resource, use it verbatim in the prompt.',
      'If the user did NOT specify a resource, use EXACTLY one of these placeholder formats:',
      '  [CHANNEL_NAME]  — for Slack channels',
      '  [REPO_NAME]     — for GitHub repositories',
      '  [PROJECT_KEY]   — for Jira projects',
      '  [CALENDAR_NAME] — for Google Calendar calendars',
      'Use ONLY these exact placeholder formats — never invent others.',
      '',
      'Default delivery to "chat" unless the user explicitly says "silent" or "notify".',
      'Include only the relevant trigger field (schedule, hook, or webhook).',
      'For time like "9am daily", use cron mode with expr "0 9 * * *".',
      'For "remind me in X", use mode "at".',
      'For "every X", use mode "every".',
      'requiredApps: lowercase app ids needed (e.g. "slack", "github", "jira", "google").',
    ].join('\n')

    try {
      const provider = getProvider(model)
      let raw = ''
      for await (const event of provider.stream({
        model,
        systemPrompt,
        messages: [{ role: 'user', content: description }],
        tools: [],
        maxTokens: 800,
        apiKeyOverride,
      })) {
        if (event.type === 'text_delta') raw += event.content
      }

      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
      const spec = JSON.parse(cleaned) as {
        name: string
        kind: 'schedule' | 'hook' | 'webhook'
        summary: string[]
        prompt: string
        schedule?: { mode: string; at?: string; every?: string; cron?: string; tz?: string }
        hook?: { event: string }
        webhook?: Record<string, unknown>
        delivery?: { kind: string }
        requiredApps?: string[]
      }

      // Build clarification questions from any [PLACEHOLDER] markers in the prompt
      const { clarifications, missingApps: clarificationMissing } = await buildClarifications(
        spec.prompt,
        allConnectedIds,
        appById,
      )

      // Also find which required apps aren't connected (from requiredApps field)
      const requiredMissing = (spec.requiredApps ?? [])
        .filter(appId => !allConnectedIds.has(appId))
        .map(appId => ({ appId, name: appById.get(appId)?.name ?? appId }))

      // Merge missing apps (deduplicate by appId)
      const allMissing = new Map<string, MissingApp>()
      for (const m of [...clarificationMissing, ...requiredMissing]) allMissing.set(m.appId, m)

      return { ok: true, spec, clarifications, missingApps: [...allMissing.values()] }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
