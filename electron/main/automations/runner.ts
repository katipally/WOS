import { queryLoop } from '../agent/query'
import { PermissionStore } from '../agent/permissions'
import { resolveAgent } from '../agent/settings'
import { audit, type RunStatus } from './audit'
import { consent } from './consent'
import { createRunSandbox } from './sandbox'
import { registry, type AutomationRow } from './registry'
import { deliverResult } from './delivery'
import { listConnections, listAvailableApps } from '../apps/manager'

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
 * Execute a single automation. This is the heart of the automation system:
 *   1. resolve agent settings (model, system prompt, api key)
 *   2. create a sandbox scratch dir
 *   3. start an audit run
 *   4. invoke queryLoop with the automation's prompt + tool allowlist + consent gate
 *   5. capture text output, end the audit row, deliver result
 *
 * Returns the final text output (or error message).
 */
export async function runAutomation(
  automation: AutomationRow,
  opts: RunOptions = {},
): Promise<{ runId: string; output: string; error?: string }> {
  const { trigger, dryRun } = opts
  const scratchDir = createRunSandbox(`auto-${Date.now()}`)
  const runId = audit.startRun(automation.id, trigger ?? null, scratchDir)

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

  // Dedicated autonomous system prompt for headless execution.
  // Deliberately does not include the WOS chat agent's routing/subagent/creation instructions.
  // Inspired by OpenClaw's cron execution context: the agent executes the stored task directly —
  // it never creates new automations, never asks the user, just does the work.
  const baseSystemPrompt = [
    'You are an autonomous task executor. You are running as a scheduled or triggered automation — no user is present.',
    `Connected apps: ${connectedApps}`,
    `Available tools: ${allToolNames}`,
    '',
    'CRITICAL RULES:',
    '1. Execute the task described in the prompt DIRECTLY using the available tools.',
    '2. Do NOT call automation_create, automation_update, automation_delete, or any other automation management tool.',
    '   You ARE the automation — do the work, do not try to schedule or create more automations.',
    '3. Do NOT ask the user any questions. There is no user to ask.',
    '4. If a channel, repo, or resource is referenced but cannot be found or accessed, report that clearly and stop.',
    '5. If a required app is disconnected, say which app is missing and stop gracefully.',
    '6. Be concise. Report what you did and the outcome.',
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
    triggerBlock,
  ].filter(Boolean).join('\n')
  const fullPrompt = `${automation.prompt}\n\n${contextBlock}`

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
      onPermissionRequest: async (toolName) => {
        // Automation management tools are NEVER allowed from within an automation.
        // This mirrors OpenClaw's resolveCronOwnerOnlyToolAllowlist pattern:
        // the cron/automation tool is excluded from cron execution to prevent recursive creation.
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
      onAskUser: async () => {
        // Headless runs cannot ask the user. Auto-cancel.
        throw new Error('Automation runs cannot ask the user. Use a Task Flow with requires_human steps instead.')
      },
      agentKey: 'wos',
    })) {
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
  }

  // Promote status to 'error' if any tool was silently denied.
  // Previously these were swallowed and the run reported 'success' even though nothing worked.
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

  if (status !== 'error' && !dryRun) {
    try {
      await deliverResult(automation, output, runId)
    } catch (err) {
      if (process.env.WOS_DEBUG === '1') console.warn('[automations.runner] delivery failed', err)
    }
  }

  return { runId, output, error: errorMessage }
}
