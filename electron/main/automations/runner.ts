import { BrowserWindow, Notification } from 'electron'
import { queryLoop } from '../agent/query'
import { PermissionStore } from '../agent/permissions'
import { resolveAgent, resolveApiKeyForModel } from '../agent/settings'

import { audit, type RunStatus } from './audit'
import { consent } from './consent'
import { createRunSandbox } from './sandbox'
import { registry, type AutomationRow } from './registry'
import { deliverResult } from './delivery'
import { listConnections, listAvailableApps } from '../apps/manager'
import { getAllSnapshots } from '../context/snapshotManager'
import { registerQuestion, cancelQuestionsForRun } from './questions'

/**
 * In-flight automation runs keyed by runId. Allows the runtime to abort all
 * active automations on `stop()` (e.g. master switch off, app quit) so we don't
 * leak HTTP streams or token spend after the user disables the feature.
 */
const inflight = new Map<string, AbortController>()

export function abortAllRuns(): number {
  const n = inflight.size
  for (const c of inflight.values()) {
    try { c.abort() } catch { /* ignore */ }
  }
  inflight.clear()
  return n
}

export function abortRunsForAutomation(automationId: string): number {
  let n = 0
  for (const [runId, c] of inflight.entries()) {
    if (runId.startsWith(`${automationId}:`)) {
      try { c.abort(); n++ } catch { /* ignore */ }
      inflight.delete(runId)
      // Cancel any pending questions for this run
      const runIdPart = runId.split(':')[1]
      if (runIdPart) cancelQuestionsForRun(runIdPart)
    }
  }
  return n
}

interface RunOptions {
  /** Trigger context (cron tick, hook event, webhook payload, …) */
  trigger?: unknown
  /** When true, skip side-effects: record run as 'dryrun' but still execute prompt. */
  dryRun?: boolean
}

/**
 * Build XML context blocks from app snapshots so the autonomous agent
 * knows the actual resource IDs (channel IDs, repo names, etc.) rather
 * than having to discover them via tool calls — which often fail when
 * the agent guesses wrong names.
 */
function buildSnapshotContextBlocks(snapshots: Array<{ appId: string; scope: string; data: unknown[] }>): string {
  const blocks: string[] = []

  // Group by appId
  const byApp = new Map<string, Array<{ scope: string; data: unknown[] }>>()
  for (const s of snapshots) {
    if (!byApp.has(s.appId)) byApp.set(s.appId, [])
    byApp.get(s.appId)!.push({ scope: s.scope, data: s.data })
  }

  for (const [appId, scopes] of byApp) {
    for (const { scope, data } of scopes) {
      if (!data || data.length === 0) continue
      const capped = data.slice(0, 50)
      const tag = `${appId}_${scope}`.replace(/[^a-z0-9_]/g, '_')

      const lines = capped.map(item => {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          // Format common resource types nicely
          const name = obj.name ?? obj.full_name ?? obj.summary ?? obj.title ?? obj.channel ?? obj.display_name
          const id = obj.id ?? obj.key ?? obj.channel_id
          const desc = obj.description ?? obj.num_members != null ? `${obj.num_members} members` : undefined
          if (name && id) return `  ${name} (id: ${id}${desc ? ', ' + desc : ''})`
          if (name) return `  ${name}`
          return `  ${JSON.stringify(item)}`
        }
        return `  ${item}`
      })

      blocks.push(`<${tag}>\n${lines.join('\n')}\n</${tag}>`)
    }
  }

  return blocks.join('\n')
}

/**
 * Execute a single automation. This is the heart of the automation system:
 *   1. resolve agent settings (model, system prompt, api key)
 *   2. create a sandbox scratch dir
 *   3. start an audit run
 *   4. inject rich snapshot context from connected apps
 *   5. invoke queryLoop with the automation's prompt + tool allowlist + consent gate
 *   6. capture text output, end the audit row, deliver result
 *
 * Returns the final text output (or error message).
 */
export async function runAutomation(
  automation: AutomationRow,
  opts: RunOptions = {},
): Promise<{ runId: string; output: string; error?: string }> {
  const { trigger, dryRun } = opts
  const scratchDir = createRunSandbox(`auto-${Date.now()}`)

  // Store prompt alongside trigger for diagnosis
  const triggerWithPrompt = { ...(typeof trigger === 'object' && trigger !== null ? trigger : { _raw: trigger }), _prompt: automation.prompt }
  const runId = audit.startRun(automation.id, triggerWithPrompt, scratchDir)

  // Resolve agent settings — prefer the dedicated automation agent, then fall
  // back to the WOS agent (model + system prompt). This lets users control
  // automation behavior independently in Settings → Agents → Automation.
  let agent = await resolveAgent('automation')
  if (!agent.model || !agent.model.trim()) {
    agent = await resolveAgent('wos')
  }
  let model = agent.model
  if (!model || !model.trim()) {
    const msg = 'No model configured for automations. Open Settings → Agents → Automation and pick a model.'
    audit.endRun(runId, 'error', null, msg)
    return { runId, output: '', error: msg }
  }

  const permStore = new PermissionStore()
  const toolCalls: Array<{ tool: string; args: unknown; result: unknown; error?: string }> = []
  let output = ''
  let status: RunStatus = dryRun ? 'dryrun' : 'success'
  let errorMessage: string | undefined

  const runAbort = new AbortController()
  inflight.set(`${automation.id}:${runId}`, runAbort)

  // Build runtime context: discover what tools and apps are actually available
  // so the autonomous agent can adapt rather than fail silently.
  const { getAllTools } = await import('../tools')
  const allToolNames = getAllTools().map(t => t.name).join(', ')
  const allApps = listAvailableApps()
  const appById = new Map(allApps.map(a => [a.id, a]))
  const connectedApps = listConnections()
    .map(c => `${appById.get(c.appId)?.name ?? c.appId} (${c.enabled ? 'connected' : 'disconnected'})`)
    .join(', ') || 'none'

  // Fetch rich snapshot context from connected apps so the agent knows
  // actual resource IDs (Slack channel IDs, GitHub repo names, etc.)
  let snapshotContext = ''
  try {
    const snapshots = getAllSnapshots()
    snapshotContext = buildSnapshotContextBlocks(snapshots)
  } catch { /* snapshot fetch failed — continue without */ }

  // Dedicated autonomous system prompt for headless execution.
  const baseSystemPrompt = [
    'You are an autonomous task executor. You are running as a scheduled or triggered automation — no user is present.',
    `Connected apps: ${connectedApps}`,
    `Available tools: ${allToolNames}`,
    '',
    'CRITICAL RULES:',
    '1. Execute the task described in the prompt DIRECTLY using the available tools.',
    '2. Do NOT call automation_create, automation_update, automation_delete, or any other automation management tool.',
    '   You ARE the automation — do the work, do not try to schedule or create more automations.',
    '3. If you need clarification, use the AskUser tool — it will pause the run and notify the user.',
    '4. If a channel, repo, or resource is referenced but cannot be found or accessed, report that clearly and stop.',
    '5. If a required app is disconnected, say which app is missing and stop gracefully.',
    '6. Be concise. Report what you did and the outcome.',
    '7. You CAN delegate subtasks to other agents using the Task tool.',
  ].join('\n')
  const autonomousSystemPrompt = agent.systemPrompt && agent.systemPrompt.trim()
    ? `${baseSystemPrompt}\n\n## Additional instructions\n${agent.systemPrompt.trim()}`
    : baseSystemPrompt

  // Build full prompt: intent + runtime context blocks for adaptive execution
  const triggerBlock = trigger
    ? `<trigger>\n${typeof trigger === 'string' ? trigger : JSON.stringify(trigger, null, 2)}\n</trigger>`
    : ''
  const contextBlock = [
    `<available_tools>${allToolNames}</available_tools>`,
    `<connected_apps>${connectedApps}</connected_apps>`,
    snapshotContext,
    triggerBlock,
  ].filter(Boolean).join('\n')
  const fullPrompt = `${automation.prompt}\n\n${contextBlock}`

  // Delivery conversationId: pass through so tools like Task can write to the right chat
  const deliveryConversationId = automation.resultTarget ?? undefined

  // Collect renderer windows for live event streaming
  const wins = BrowserWindow.getAllWindows()

  try {
    for await (const event of queryLoop({
      model,
      messages: [],
      userMessage: fullPrompt,
      workspacePath: scratchDir,
      mode: 'default',
      reasoningEffort: 'medium',
      systemPromptOverride: autonomousSystemPrompt,
      apiKeyOverride: agent.apiKeyOverride,
      signal: runAbort.signal,
      permissionStore: permStore,
      conversationId: deliveryConversationId,
      agentKey: 'automation',
      onPermissionRequest: async (toolName) => {
        // Automation management tools are NEVER allowed from within an automation.
        const AUTOMATION_MANAGEMENT = new Set([
          'automation_create', 'automation_update', 'automation_delete',
          'automation_toggle', 'automation_run_now',
        ])
        if (AUTOMATION_MANAGEMENT.has(toolName)) {
          return 'deny'
        }

        // Enforce explicit allowlist if set (non-empty = user restricted this automation).
        if (automation.toolsAllow.length && !automation.toolsAllow.includes(toolName)) {
          return 'deny'
        }

        if (consent.isDestructive(toolName) && !consent.has(automation.id, toolName)) {
          return 'deny'
        }
        if (dryRun && consent.isDestructive(toolName)) {
          return 'deny'
        }
        return 'allow-session'
      },
      onAskUser: async (question, questionId, choices, extras) => {
        return new Promise<string>((resolve, reject) => {
          registerQuestion({ questionId, automationId: automation.id, runId, question, extras, resolve, reject })

          // Emit question to all renderer windows
          for (const win of wins) {
            try {
              win.webContents.send('automations:question', {
                automationId: automation.id,
                runId,
                questionId,
                question,
                extras,
                choices,
              })
            } catch { /* window destroyed */ }
          }

          // OS notification
          try {
            new Notification({
              title: `"${automation.name}" needs your input`,
              body: question,
            }).show()
          } catch { /* notifications unavailable */ }
        })
      },
    })) {
      // Emit live events to renderer for real-time progress display
      const liveEventTypes = new Set(['text_delta', 'tool_use_start', 'tool_result', 'error'])
      if (liveEventTypes.has(event.type)) {
        for (const win of wins) {
          try {
            win.webContents.send('automations:runEvent', { runId, automationId: automation.id, event })
          } catch { /* window destroyed */ }
        }
      }

      switch (event.type) {
        case 'text_delta':
          output += event.content
          break
        case 'tool_use_start':
          toolCalls.push({ tool: event.toolName, args: event.input, result: null })
          break
        case 'tool_result': {
          const last = toolCalls[toolCalls.length - 1]
          if (last) {
            last.result = event.result
            if (event.error) last.error = event.error
          }
          break
        }
        case 'error':
          errorMessage = event.message
          status = 'error'
          break
        default:
          break
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    status = 'error'
  } finally {
    inflight.delete(`${automation.id}:${runId}`)
    cancelQuestionsForRun(runId)
  }

  // Promote status to 'error' if any tool was silently denied.
  if (status !== 'error') {
    const denied = toolCalls.filter(tc =>
      tc.error?.toLowerCase().includes('denied') ||
      tc.error?.toLowerCase().includes('permission') ||
      tc.error?.toLowerCase().includes('blocked by policy')
    )
    if (denied.length > 0) {
      status = 'error'
      const names = [...new Set(denied.map(t => t.tool))].join(', ')
      errorMessage = `Tool access denied: ${names}. Ensure the required apps are connected and tools are available.`
    }
  }

  audit.endRun(runId, status, output || null, errorMessage ?? null, toolCalls)
  registry.setLastRun(automation.id, new Date())

  // Emit run-complete event so UI can update
  for (const win of wins) {
    try {
      win.webContents.send('automations:runEvent', {
        runId,
        automationId: automation.id,
        event: { type: 'run_complete', status, error: errorMessage },
      })
    } catch { /* window destroyed */ }
  }

  if (status !== 'error' && !dryRun) {
    try {
      await deliverResult(automation, output, runId)
    } catch (err) {
      if (process.env.WOS_DEBUG === '1') console.warn('[automations.runner] delivery failed', err)
    }
  }

  return { runId, output, error: errorMessage }
}
