import { ipcMain } from 'electron'
import { registry, type AutomationKind, type ResultDelivery } from '../automations/registry'
import { audit } from '../automations/audit'
import { runAutomation } from '../automations/runner'
import { automationsRuntime } from '../automations'
import { ensureWebhook } from '../automations/webhooks'
import { refreshTrayMenu } from '../tray'
import { listConnections, listAvailableApps } from '../apps/manager'
import { resolveAgent } from '../agent/settings'
import { getProvider } from '../providers'
import { getDb, schema } from '../db'
import { eq } from 'drizzle-orm'

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

  ipcMain.handle('automations:parseDescription', async (_evt, args: { description: string }) => {
    const { description } = args

    // Gather runtime context
    const allApps = listAvailableApps()
    const appById = new Map(allApps.map(a => [a.id, a]))
    const conns = listConnections()
    const connectedAppNames = conns
      .filter(c => c.enabled)
      .map(c => appById.get(c.appId)?.name ?? c.appId)
    const allConnectedIds = new Set(conns.filter(c => c.enabled).map(c => c.appId))

    // Resolve model + API key (per-persona override → wos → defaultModel)
    let model = ''
    let apiKeyOverride: string | undefined
    try {
      const spec = await resolveAgent('automation')
      if (spec.model) {
        model = spec.model
        apiKeyOverride = spec.apiKeyOverride
      }
    } catch { /* fall through */ }
    if (!model) {
      try {
        const agent = await resolveAgent('wos')
        model = agent.model ?? ''
        apiKeyOverride = agent.apiKeyOverride
      } catch { /* no model configured */ }
    }

    if (!model) {
      const db = getDb()
      const modelSetting = db.select().from(schema.settings).where(eq(schema.settings.key, 'defaultModel')).get()
      model = (modelSetting?.value as string)?.replace(/^"|"$/g, '') || ''
    }

    if (!model) {
      return { ok: false, error: 'No AI model configured. Set a model in Settings to use this feature.' }
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
      '  "delivery": { "kind": "silent" | "notify" | "chat" },',
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
      '  "create a summary automation for the channel"  ← meta-instruction, not a task',
      '',
      'RIGHT (use actual names from the user description):',
      '  "Read the last 24 hours of messages from #all-agent-testing on Slack. Summarize the key discussions, decisions, blockers, and action items. Post the summary back to #all-agent-testing."',
      '  "Check my Google Calendar for meetings tomorrow. List each meeting with attendees and duration."',
      '',
      'If the user specified a channel/repo/resource, use it verbatim in the prompt.',
      'If the user did NOT specify a resource and you cannot infer it, use a clear placeholder like [CHANNEL_NAME] — do NOT guess.',
      '',
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

      // Strip markdown fences if model wraps response
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

      // Find which required apps aren't connected
      const missingApps = (spec.requiredApps ?? [])
        .filter(appId => !allConnectedIds.has(appId))
        .map(appId => ({
          appId,
          name: appById.get(appId)?.name ?? appId,
        }))

      return { ok: true, spec, missingApps }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
