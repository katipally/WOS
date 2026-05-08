import type { Tool } from './index'
import { listConnections, listAvailableApps } from '../apps/manager'
import { listServers as listMcpServers, listTools as listMcpTools } from '../mcp/manager'
import { registry, type AutomationKind } from '../automations/registry'
import { automationsRuntime } from '../automations'
import { runAutomation } from '../automations/runner'
import { createAutomation, type AutomationCreateSpec } from '../automations/runtime'

const KIND_LIST: AutomationKind[] = ['schedule', 'hook', 'webhook']

/**
 * Detect placeholder phrasing that an LLM commonly emits when it failed to
 * resolve concrete resources before calling automation_create. We refuse the
 * call so the agent re-asks the user instead of silently saving a broken spec.
 *
 * Returns the offending phrase, or null if the spec looks fully resolved.
 */
function detectPlaceholder(spec: { message?: string; name?: string }): string | null {
  const patterns: RegExp[] = [
    /\bthe (specified|selected|target|chosen|user'?s|user is) /i,
    /\b(your|that) (channel|repo|repository|project|workspace|server)\b/i,
    /\b<[^>]{2,40}>\b/,
    /\{\{[^}]+\}\}/,
    /\[(channel|user|recipient|email|target)\]/i,
    /\bplaceholder\b/i,
  ]
  const fields: Array<string | undefined> = [spec.message, spec.name]
  for (const f of fields) {
    if (!f) continue
    for (const re of patterns) {
      const m = f.match(re)
      if (m) return m[0]
    }
  }
  return null
}

const CREATE_DESCRIPTION = [
  'Create or replace an automation in ONE call. Returns { ok:true, id, kind, summary } on success or { ok:false, error:{field,expected,got,hint} } on validation failure — read the error and fix the offending field on your next attempt.',
  '',
  'Three primitives:',
  '  • schedule — runs on a clock. Required: schedule:{ mode:"at"|"every"|"cron", ... }',
  '      mode="at"    → schedule:{ mode:"at",    at:"<ISO 8601 or relative like 20m, 2h, 45s>" }   one-shot, deleted after firing',
  '      mode="every" → schedule:{ mode:"every", every:"<duration like 30s, 5m, 2h>" }              recurring, min 5s',
  '      mode="cron"  → schedule:{ mode:"cron",  cron:"0 9 * * *", tz:"America/Los_Angeles" }       cron expression + IANA tz',
  '  • hook    — runs when a WOS event fires. Required: hook:{ event:"meeting:saved" | "session:new" | ... }',
  '  • webhook — runs on inbound HTTPS POST. webhook:{ slug?, secret? }  (slug+secret minted automatically)',
  '',
  '## The message field — THE MOST IMPORTANT FIELD',
  'The message is executed verbatim by an autonomous agent with NO access to the current conversation.',
  'It must be a DIRECT, SELF-CONTAINED task instruction with all resources fully resolved.',
  '',
  'WRONG (never do this):',
  '  ❌ message: "Create an automation that summarizes the Slack channel"',
  '  ❌ message: "Set up the daily standup summary for the specified channel"',
  '  ❌ message: "Review messages from the target channel and post a summary"',
  '  (These all fail: "the specified channel" is a placeholder the autonomous agent can\'t resolve)',
  '',
  'RIGHT:',
  '  ✓ message: "Read the last 24 hours of messages from #engineering on Slack. Summarize the key discussions, decisions, and action items. Post the summary to #engineering."',
  '  ✓ message: "Check my Google Calendar for meetings tomorrow. For each meeting, create a brief prep note with the attendees and known agenda."',
  '',
  'toolsAllow: Leave as [] (empty) in almost all cases — the runtime agent uses whatever tools are available.',
  'Only set specific tools if the user explicitly wants to restrict the automation.',
  '',
  'WORKED EXAMPLES:',
  '  • "Remind me in 20 minutes" →',
  '      automation_create({ name:"20-min Reminder", kind:"schedule", schedule:{ mode:"at", at:"20m" }, message:"The 20-minute timer has elapsed. Notify the user." })',
  '  • User asked for daily standup of #engineering at 9am (channel already confirmed) →',
  '      automation_create({ name:"Daily standup summary", kind:"schedule", schedule:{ mode:"cron", cron:"0 9 * * 1-5" }, message:"Read the last 24 hours of messages from #engineering on Slack. Write a concise summary of: key discussions, decisions made, open questions, blockers, and action items. Post the summary to #engineering." })',
  '  • "After every meeting, summarise it" →',
  '      automation_create({ name:"Meeting auto-summary", kind:"hook", hook:{ event:"meeting:saved" }, message:"The meeting just ended. Summarise it in 5 bullets covering key decisions and action items. Save to memory." })',
  '',
  'Do NOT call this multiple times for the same automation.',
  'Do NOT use placeholder text for resources — resolve them first with AskUser if needed.',
  'Timezone defaults to the user\'s configured zone. Delivery defaults to inline. Consent for bash/fileWrite/fileEdit is auto-granted.',
].join('\n')

export const automationTools: Tool[] = [
  {
    name: 'automation_listConnectedApps',
    description: 'List apps the user has connected (Slack, GitHub, Google, …). Use to discover what tools the automation can call.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const conns = listConnections()
      const all = listAvailableApps()
      const byId = new Map(all.map(a => [a.id, a]))
      return {
        output: conns.map(c => ({
          appId: c.appId,
          name: byId.get(c.appId)?.name ?? c.appId,
          enabled: c.enabled,
        })),
      }
    },
  },
  {
    name: 'automation_listMcpServers',
    description: 'List configured MCP servers and (optionally) their tools.',
    inputSchema: {
      type: 'object',
      properties: {
        includeTools: { type: 'boolean', description: 'When true, include each server\'s exposed tool names.' },
      },
    },
    async execute(input) {
      const includeTools = (input as { includeTools?: boolean } | undefined)?.includeTools
      const servers = listMcpServers()
      if (!includeTools) {
        return { output: servers.map(s => ({ id: s.id, name: s.name, enabled: s.enabled })) }
      }
      const out: Array<{ id: string; name: string; enabled: boolean; tools: string[] }> = []
      for (const s of servers) {
        let toolNames: string[] = []
        try {
          const t = await listMcpTools(s.id)
          toolNames = t.map(x => x.name)
        } catch { /* offline / not connected */ }
        out.push({ id: s.id, name: s.name, enabled: s.enabled, tools: toolNames })
      }
      return { output: out }
    },
  },
  {
    name: 'automation_listTools',
    description: 'List all tools currently available to the WOS agent (built-ins + connected apps + MCP). Use to understand what the automation runtime will have access to. You rarely need to set toolsAllow — leave it empty to allow all.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const { getAllTools } = await import('./index')
      const tools = getAllTools()
      return {
        output: tools.map(t => ({ name: t.name, description: t.description })),
      }
    },
  },
  {
    name: 'automation_create',
    description: CREATE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional. When provided, replaces an existing automation with the same id.' },
        name: { type: 'string' },
        kind: { type: 'string', enum: KIND_LIST },
        enabled: { type: 'boolean' },
        message: { type: 'string', description: 'The natural-language prompt the agent runs when this automation fires.' },
        toolsAllow: { type: 'array', items: { type: 'string' } },
        schedule: {
          type: 'object',
          description: 'Required when kind="schedule".',
          properties: {
            mode: { type: 'string', enum: ['at', 'every', 'cron'] },
            at: { type: 'string', description: 'ISO 8601 timestamp OR relative duration ("20m", "2h", "45s"). Used when mode="at".' },
            every: { type: 'string', description: 'Duration like "30s", "5m", "2h". Used when mode="every". Min 5 seconds.' },
            cron: { type: 'string', description: '5- or 6-field cron expression. Used when mode="cron".' },
            tz: { type: 'string', description: 'IANA timezone (e.g. "America/Los_Angeles"). Defaults to the user\'s configured zone.' },
            deleteAfterRun: { type: 'boolean', description: 'For mode="at" only. Default true.' },
            jitterSec: { type: 'number', description: 'For mode="every" only. Random additional delay in seconds.' },
          },
        },
        hook: {
          type: 'object',
          description: 'Required when kind="hook".',
          properties: { event: { type: 'string' } },
        },
        webhook: {
          type: 'object',
          description: 'Optional config when kind="webhook". Slug + secret are minted automatically.',
          properties: { slug: { type: 'string' }, secret: { type: 'string' } },
        },
        delivery: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['inline', 'channel', 'webhook', 'silent', 'notify', 'chat', 'external'] },
            channel: { type: 'string' },
            url: { type: 'string' },
          },
        },
        description: { type: 'string' },
      },
      required: ['name', 'kind', 'message'],
    },
    async execute(input) {
      const spec = input as AutomationCreateSpec & { message?: string; name?: string }
      const placeholder = detectPlaceholder(spec)
      if (placeholder) {
        return {
          output: '',
          error: `Refused: automation contains an unresolved placeholder (${placeholder}). Resolve concrete values (channel id, target, recipient, etc.) by asking the user via AskUser before calling automation_create.`,
        }
      }
      const result = createAutomation(spec, { fromAgent: true })
      return { output: result }
    },
  },
  {
    name: 'automation_run_now',
    description: 'Manually trigger an existing automation by id. Returns { ok, runId, output, error? }. Use { dryRun: true } to preview without side effects.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['id'],
    },
    async execute(input) {
      const { id, dryRun } = input as { id: string; dryRun?: boolean }
      const row = registry.get(id)
      if (!row) return { output: { ok: false, error: `Automation ${id} not found.` } }
      const r = await runAutomation(row, { dryRun: !!dryRun, trigger: { kind: 'manual', firedAt: new Date().toISOString() } })
      return {
        output: {
          ok: !r.error,
          runId: r.runId,
          output: r.output,
          error: r.error,
        },
      }
    },
  },
  {
    name: 'automation_update',
    description: 'Update an existing automation. Pass only the fields to change. To change the schedule/hook/webhook config, pass a complete replacement block (e.g. schedule:{mode,...}).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        message: { type: 'string' },
        toolsAllow: { type: 'array', items: { type: 'string' } },
        schedule: { type: 'object' },
        hook: { type: 'object' },
        webhook: { type: 'object' },
        delivery: { type: 'object' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(input) {
      const patch = input as Partial<AutomationCreateSpec> & { id: string }
      const existing = registry.get(patch.id)
      if (!existing) return { output: { ok: false, error: `Automation ${patch.id} not found.` } }
      const cfg = existing.config as Record<string, unknown>
      const merged: AutomationCreateSpec = {
        id: existing.id,
        kind: existing.kind,
        name: patch.name ?? existing.name,
        enabled: patch.enabled ?? existing.enabled,
        message: patch.message ?? existing.prompt,
        toolsAllow: patch.toolsAllow ?? existing.toolsAllow,
        description: patch.description ?? existing.description ?? undefined,
        delivery: patch.delivery,
      }
      if (existing.kind === 'schedule') {
        merged.schedule = patch.schedule ?? {
          mode: cfg.mode as 'at' | 'every' | 'cron',
          at: cfg.at as string | undefined,
          every: cfg.every as string | undefined,
          cron: cfg.cron as string | undefined,
          tz: cfg.tz as string | undefined,
          deleteAfterRun: cfg.deleteAfterRun as boolean | undefined,
          jitterSec: cfg.jitterSec as number | undefined,
        }
      } else if (existing.kind === 'hook') {
        merged.hook = patch.hook ?? { event: String(cfg.event ?? '') }
      } else if (existing.kind === 'webhook') {
        merged.webhook = patch.webhook ?? {
          slug: cfg.slug as string | undefined,
          secret: cfg.secret as string | undefined,
        }
      }
      const result = createAutomation(merged)
      return { output: result }
    },
  },
  {
    name: 'automation_delete',
    description: 'Delete an automation by id. Stops any active scheduling/listening for it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async execute(input) {
      const id = (input as { id: string }).id
      const existing = registry.get(id)
      if (!existing) return { output: { ok: false, error: `Automation ${id} not found.` } }
      registry.delete(id)
      automationsRuntime.reload(id)
      return { output: { ok: true, id } }
    },
  },
  {
    name: 'automation_toggle',
    description: 'Enable or disable an automation by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
    },
    async execute(input) {
      const { id, enabled } = input as { id: string; enabled: boolean }
      const row = registry.toggle(id, enabled)
      if (!row) return { output: { ok: false, error: `Automation ${id} not found.` } }
      automationsRuntime.reload(id)
      return { output: { ok: true, automation: row } }
    },
  },
  {
    name: 'automation_list',
    description: 'List existing automations. Optionally filter by kind or enabled state.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KIND_LIST },
        enabled: { type: 'boolean' },
      },
    },
    async execute(input) {
      const { kind, enabled } = (input as { kind?: AutomationKind; enabled?: boolean } | undefined) ?? {}
      const rows = registry.list({ kind, enabled })
      return { output: rows }
    },
  },
  {
    name: 'automation_get',
    description: 'Fetch a single automation by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async execute(input) {
      const id = (input as { id: string }).id
      const row = registry.get(id)
      if (!row) return { output: '', error: `Automation ${id} not found.` }
      return { output: row }
    },
  },
]
