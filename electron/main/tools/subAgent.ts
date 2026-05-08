import { randomUUID } from 'node:crypto'
import { queryLoop } from '../agent/query'
import { PermissionStore } from '../agent/permissions'
import { getDb, schema } from '../db'
import { eq } from 'drizzle-orm'
import type { Tool, ToolContext, ToolResult } from './index'
import type { ConversationMessage } from '../providers/types'
import { resolveAgent } from '../agent/settings'
import { registerSubagent, unregisterSubagent, getCurrentBreadth } from '../agent/subagentRegistry'

/** Read subagent limits from settings DB, with sensible defaults. */
function getSubagentLimits(): { maxDepth: number; maxBreadth: number } {
  try {
    const db = getDb()
    const depthRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'maxSubagentDepth')).get()
    const breadthRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'maxSubagentBreadth')).get()
    const maxDepth = depthRow ? Number(depthRow.value) || 3 : 3
    const maxBreadth = breadthRow ? Number(breadthRow.value) || 5 : 5
    return { maxDepth, maxBreadth }
  } catch {
    return { maxDepth: 3, maxBreadth: 5 }
  }
}

/** Stable integer 0-6 derived from agentId for UI color coding. */
function stableColorSeed(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) >>> 0
  }
  return h % 7
}

/**
 * Derive a short, human-readable subagent name from its description so the UI
 * doesn't fall back to the literal word "task". Picks the first 2-3
 * significant words, kebab-cased.
 */
function deriveSubagentName(description: string): string {
  if (!description) return 'task'
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'by',
    'from', 'into', 'about', 'as', 'is', 'are', 'be', 'this', 'that', 'these',
    'those', 'it', 'its', 'use', 'using', 'do',
  ])
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !stop.has(w))
    .slice(0, 3)
  if (words.length === 0) return 'task'
  return words.join('-').slice(0, 32)
}

/** Per-agentId AbortControllers so /subagents kill can cancel in-flight runs. */
const _inFlightControllers = new Map<string, AbortController>()

/** Cancel a running subagent by agentId. Returns true if found and cancelled. */
export function cancelSubagent(agentId: string): boolean {
  const ctrl = _inFlightControllers.get(agentId)
  if (!ctrl) return false
  ctrl.abort()
  return true
}

/** List all currently-running subagent IDs. */
export function listRunningSubagentIds(): string[] {
  return [..._inFlightControllers.keys()]
}

interface SubAgentInput {
  description: string
  prompt: string
  /** Preset agent to run, for example "meeting". */
  preset?: string
  presetKey?: string
  /** When true, start from a snapshot of the parent's conversation (for prefix cache reuse). */
  fork?: boolean
  /**
   * Fan-out mode: when true, the tool runs one subagent **per prompt in
   * `prompts`** concurrently and returns an array of results. The breadth
   * limit is enforced per launch (we only kick off as many as the registry
   * has room for; the rest fail fast). `description` is reused as a prefix
   * label and indexed (`#1`, `#2`, ...).
   */
  parallel?: boolean
  /** List of prompts when `parallel: true`. Each becomes one subagent. */
  prompts?: string[]
}

export const subAgentTool: Tool = {
  name: 'Task',
  description: 'Spawn a subagent to handle a specific task. The subagent has its own context and tools. Use for parallelizable or complex subtasks. Set `fork: true` to inherit parent context for prefix cache reuse (recommended for tightly-coupled subtasks). For fan-out, set `parallel: true` and pass `prompts: string[]` — one subagent runs per prompt concurrently and an array of results is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Brief description of what this subagent will do' },
      prompt: { type: 'string', description: 'Detailed instructions for the subagent (single-run mode)' },
      preset: { type: 'string', description: 'Optional preset agent key, e.g. "meeting".' },
      presetKey: { type: 'string', description: 'Alias for preset.' },
      fork: { type: 'boolean', description: 'If true, inherit parent conversation context (cache-efficient).' },
      parallel: { type: 'boolean', description: 'If true, run one subagent per entry in `prompts` concurrently and return an array of results.' },
      prompts: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of prompts when parallel=true. Each becomes its own subagent run.',
      },
    },
    required: ['description'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const i = input as SubAgentInput
    if (i.parallel && Array.isArray(i.prompts) && i.prompts.length > 0) {
      const { maxBreadth } = getSubagentLimits()
      const parentId = (ctx.extras?.subagentId as string) ?? null
      const available = Math.max(0, maxBreadth - getCurrentBreadth(parentId))
      if (available <= 0) {
        return {
          output: `Parallel fan-out blocked: breadth limit (${maxBreadth}) already reached.`,
          error: `Max subagent breadth (${maxBreadth}) exceeded`,
        }
      }
      const prompts = i.prompts.slice(0, available)
      const skipped = i.prompts.length - prompts.length
      const results = await Promise.all(
        prompts.map((p, idx) =>
          runSingleSubAgent(
            {
              description: `${i.description} #${idx + 1}`,
              prompt: p,
              preset: i.preset,
              presetKey: i.presetKey,
              fork: i.fork ?? true,
            },
            ctx,
          ),
        ),
      )
      const summary = results.map((r, idx) => ({
        index: idx,
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
        error: r.error,
      }))
      return {
        output: JSON.stringify({
          parallel: true,
          count: results.length,
          skipped,
          results: summary,
        }),
      }
    }
    if (!i.prompt) return { output: '', error: 'Subagent prompt is required (or pass parallel:true with prompts[])' }
    return runSingleSubAgent(i, ctx)
  },
}

async function runSingleSubAgent(input: SubAgentInput, ctx: ToolContext): Promise<ToolResult> {
    const { description, prompt, fork = true } = input
    const preset = input.presetKey ?? input.preset
    const agentId = randomUUID()
    const agentName = preset ?? deriveSubagentName(description)
    const colorSeed = stableColorSeed(agentId)
    const startedAt = new Date()

    // Enforce depth and breadth limits
    const currentDepth = (ctx.extras?.subagentDepth as number) ?? 0
    const parentId = (ctx.extras?.subagentId as string) ?? null
    const { maxDepth, maxBreadth } = getSubagentLimits()

    if (currentDepth >= maxDepth) {
      return {
        output: `Subagent spawn blocked: maximum depth of ${maxDepth} reached. Cannot spawn further nested subagents.`,
        error: `Max subagent depth (${maxDepth}) exceeded`,
      }
    }

    const currentBreadth = getCurrentBreadth(parentId)
    if (currentBreadth >= maxBreadth) {
      return {
        output: `Subagent spawn blocked: maximum of ${maxBreadth} parallel subagents already running for this parent. Wait for one to complete.`,
        error: `Max subagent breadth (${maxBreadth}) exceeded`,
      }
    }

    const db = getDb()
    const conversationId = ctx.conversationId
    let taskId: string | null = null
    if (conversationId) {
      try {
        db.insert(schema.subagentRuns).values({
          id: agentId,
          parentMessageId: ctx.toolId ?? null,
          conversationId,
          status: 'running',
          goal: description,
          summary: null,
          tokensIn: 0,
          tokensOut: 0,
          startedAt,
          endedAt: null,
        }).run()
        taskId = randomUUID()
        db.insert(schema.tasks).values({
          id: taskId,
          type: 'subagent',
          status: 'running',
          title: description,
          conversationId,
          createdAt: startedAt,
          updatedAt: startedAt,
        }).run()
      } catch (err) {
        if (process.env.WOS_DEBUG === '1') console.warn('[subAgent] ledger write failed', err)
      }
    }

    const finishLedger = (status: 'success' | 'error' | 'cancelled', summary: string | null) => {
      if (!conversationId) return
      const endedAt = new Date()
      try {
        db.update(schema.subagentRuns)
          .set({ status, summary, endedAt })
          .where(eq(schema.subagentRuns.id, agentId))
          .run()
        if (taskId) {
          db.update(schema.tasks)
            .set({ status, updatedAt: endedAt })
            .where(eq(schema.tasks.id, taskId))
            .run()
        }
      } catch (err) {
        if (process.env.WOS_DEBUG === '1') console.warn('[subAgent] ledger finalize failed', err)
      }
    }

    const { runBeforeSubagent } = await import('../hooks/manager')
    const gate = await runBeforeSubagent(preset ?? 'wos', input, {
      workspacePath: ctx.workspacePath ?? null,
      agentKey: ctx.agentKey,
    })
    if (gate.block) {
      const reason = gate.reason ?? 'blocked by hook'
      await ctx.yieldEvent({ type: 'subagent_start', agentId, agentName, colorSeed, prompt: description })
      await ctx.yieldEvent({ type: 'subagent_end', agentId, agentName, colorSeed, result: `Blocked: ${reason}` })
      finishLedger('cancelled', `blocked: ${reason}`)
      return { output: `Subagent blocked: ${reason}`, error: reason }
    }

    await ctx.yieldEvent({ type: 'subagent_start', agentId, agentName, colorSeed, prompt: description })

    let result = ''
    const permStore = new PermissionStore()
    // Preserve structured content (tool_use/tool_result) when forking.
    const inheritedMessages: ConversationMessage[] = fork && ctx.parentMessages
      ? ctx.parentMessages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content
            : (m.content as ConversationMessage['content']),
        }))
      : []

    // Track this run's AbortController so /subagents kill can cancel it.
    const runAbortController = new AbortController()
    // Chain to the parent signal so cancelling the parent also cancels this run.
    const parentSignal = ctx.signal
    const onParentAbort = () => runAbortController.abort()
    if (parentSignal) parentSignal.addEventListener('abort', onParentAbort, { once: true })
    _inFlightControllers.set(agentId, runAbortController)
    registerSubagent(agentId, parentId, currentDepth + 1)

    try {
      // Prefer the parent's model; fall back to DB default only if parent didn't pass one.
      let model = ctx.parentModel
      let mode = ctx.parentMode ?? 'default'
      let systemPromptOverride: string | undefined
      let apiKeyOverride = ctx.parentApiKeyOverride
      if (preset) {
        const agent = await resolveAgent(preset)
        if (agent.model) model = agent.model
        mode = agent.mode
        systemPromptOverride = agent.systemPrompt
        apiKeyOverride = agent.apiKeyOverride
      }
      if (!model) {
        const db = getDb()
        const modelSetting = db
          .select()
          .from(schema.settings)
          .where(eq(schema.settings.key, 'defaultModel'))
          .get()
        model = (modelSetting?.value as string)?.replace(/^"|"$/g, '') || ''
      }

      if (!model || model.trim() === '') {
        throw new Error('No AI model selected. Please go to Settings and choose a model to get started.')
      }

      for await (const event of queryLoop({
        model,
        messages: inheritedMessages,
        userMessage: prompt,
        workspacePath: ctx.workspacePath,
        mode,
        reasoningEffort: ctx.parentReasoningEffort,
        systemPromptOverride,
        apiKeyOverride,
        signal: runAbortController.signal,
        permissionStore: permStore,
        onPermissionRequest: ctx.onPermissionRequest,
        onAskUser: ctx.onAskUser,
        maxDepth: 1,
        agentKey: preset ?? 'wos',
        skipIntent: true,
        // Forward side-channel events (stdout/stderr deltas from Bash, etc.)
        // up to the parent runner so the UI can render live output.
        onEvent: (e) => ctx.yieldEvent({ type: 'subagent_event', agentId, agentName, colorSeed, event: e }),
      })) {
        await ctx.yieldEvent({ type: 'subagent_event', agentId, agentName, colorSeed, event })
        if (event.type === 'text_delta') result += event.content
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.yieldEvent({ type: 'subagent_end', agentId, agentName, colorSeed, result: `Error: ${msg}` })
      finishLedger('error', msg)
      return { output: `Subagent error: ${msg}`, error: msg }
    } finally {
      _inFlightControllers.delete(agentId)
      unregisterSubagent(agentId)
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort)
    }

    await ctx.yieldEvent({ type: 'subagent_end', agentId, agentName, colorSeed, result })
    finishLedger('success', result.slice(0, 4000) || null)
    return { output: result || '(subagent completed with no output)' }
}
