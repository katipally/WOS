import { BrowserWindow, WebContents } from 'electron'
import { queryLoop } from './query'
import type { AgentEvent } from './query'
import type { AgentMode } from './permissions'
import { PermissionStore } from './permissions'
import { getDb, schema, notifyWrite } from '../db'
import type { ConversationMessage, ContentBlock } from '../providers/types'
import { eq, asc, and, desc } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { resolveAgent, resolveApiKeyForModel } from './settings'
import { getContextWindow } from '../../../src/lib/modelCapabilities'
import { recallMemories, buildMemoryBlock, pruneOldMemories } from '../memory/memoryService'
import { extractAndStoreFacts } from '../memory/factExtractor'

const DEBUG = process.env.WOS_DEBUG === '1'
const dlog = (...args: unknown[]) => { if (DEBUG) console.log('[wos:runner]', ...args) }

type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

/**
 * Per-agent reasoning effort lives in `agent_settings.config.reasoningEffort`
 * and is set by the user in Settings → Agents. Defaults to 'medium' when
 * unset or invalid. There is intentionally no global default — each agent
 * controls its own reasoning effort.
 */
function readAgentReasoningEffort(settings: Awaited<ReturnType<typeof resolveAgent>> | null): ReasoningEffort {
  const raw = (settings?.config as Record<string, unknown> | undefined)?.reasoningEffort
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') return raw
  return 'medium'
}

export interface MessageBlock {
  type: string
  [key: string]: unknown
}

export class AgentRunner {
  private abortController: AbortController | null = null
  private pauseResolvers = new Map<string, (value: string) => void>()
  private askUserResolvers = new Map<string, { resolve: (v: string) => void; emit: (e: AgentEvent) => void }>()
  private permissionStore = new PermissionStore()

  async run(
    conversationId: string,
    userMessage: string,
    attachments: Array<{ name: string; content: string }>,
    sender?: WebContents,
  ) {
    this.abortController = new AbortController()
    const { signal } = this.abortController

    const db = getDb()

    // Load conversation
    const conv = db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get()

    if (!conv) throw new Error(`Conversation ${conversationId} not found`)

    // Guard: model must be selected before running the agent. If the
    // conversation was created before the user picked a model, fall back to
    // the WOS agent's currently configured model and persist it onto the row
    // so subsequent turns are stable. This keeps existing conversations
    // working after the user changes their default in Settings → AI & Agents.
    if (!conv.model || conv.model.trim() === '') {
      try {
        const wos = await resolveAgent('wos')
        if (wos.model && wos.model.trim()) {
          conv.model = wos.model
          db.update(schema.conversations)
            .set({ model: wos.model, updatedAt: new Date() })
            .where(eq(schema.conversations.id, conversationId))
            .run()
          notifyWrite()
        }
      } catch { /* ignore — re-throw below */ }
    }
    if (!conv.model || conv.model.trim() === '') {
      throw new Error('No AI model selected. Please go to Settings and choose a model to get started.')
    }

    // Load workspace path
    let workspacePath: string | null = null
    if (conv.workspaceId) {
      const ws = db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, conv.workspaceId))
        .get()
      workspacePath = ws?.path ?? null
    }

    // Load message history
    const msgRows = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.createdAt))
      .all()

    // Reconstruct provider-shaped messages from saved blocks. Tool-only
    // assistant turns must be preserved (as tool_use blocks) along with their
    // corresponding tool_result user turns, so follow-up calls have the
    // correct conversational context.
    //
    // For branched messages, only include the highest branchIndex per group
    // (the latest edit). Messages without a branchGroupId are always included.
    const maxBranchPerGroup: Record<string, number> = {}
    for (const m of msgRows) {
      if (m.branchGroupId) {
        const cur = maxBranchPerGroup[m.branchGroupId] ?? 0
        maxBranchPerGroup[m.branchGroupId] = Math.max(cur, m.branchIndex ?? 0)
      }
    }
    const activeMsgRows = msgRows.filter(m => {
      if (!m.branchGroupId) return true
      return (m.branchIndex ?? 0) === maxBranchPerGroup[m.branchGroupId]
    })

    const history: ConversationMessage[] = []
    for (const m of activeMsgRows) {
      const blocks = (m.blocks as MessageBlock[]) ?? []
      const role = m.role as 'user' | 'assistant'
      const textParts: string[] = []
      const blockContent: ContentBlock[] = []
      const toolResults: ContentBlock[] = []

      for (const b of blocks) {
        if (b.type === 'text') {
          const s = typeof b.content === 'string' ? b.content : ''
          if (s) {
            textParts.push(s)
            blockContent.push({ type: 'text', text: s })
          }
        } else if (b.type === 'tool_use') {
          blockContent.push({
            type: 'tool_use',
            id: b.toolId as string,
            name: b.toolName as string,
            input: (b.input ?? {}) as unknown,
          })
          if ('result' in b || 'error' in b) {
            const resultStr = b.error
              ? `Error: ${String(b.error)}`
              : typeof b.result === 'string'
                ? b.result
                : JSON.stringify(b.result ?? null)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: b.toolId as string,
              content: resultStr,
            })
          }
        }
      }

      if (role === 'assistant' && blockContent.length > 0) {
        const onlyText = blockContent.every(b => b.type === 'text')
        history.push({
          role: 'assistant',
          content: onlyText ? textParts.join('') : blockContent,
        })
        if (toolResults.length > 0) {
          history.push({ role: 'user', content: toolResults })
        }
      } else if (role === 'user') {
        const joined = textParts.join('')
        if (joined) history.push({ role: 'user', content: joined })
      }
    }

    // Build full user message with attachments
    let fullUserMessage = userMessage
    if (attachments.length > 0) {
      fullUserMessage += '\n\n' + attachments.map(a =>
        `<file name="${a.name}">\n${a.content}\n</file>`
      ).join('\n')
    }

    // Save user message to DB
    const userMsgId = randomUUID()
    db.insert(schema.messages).values({
      id: userMsgId,
      conversationId,
      role: 'user',
      blocks: JSON.stringify([{ type: 'text', content: fullUserMessage }]),
      createdAt: new Date(),
    }).run()
    notifyWrite()

    const assistantBlocks: MessageBlock[] = []
    const assistantMsgId = randomUUID()
    let turnCompleteEmitted = false
    let cumulativeInputTokens = 0
    let cumulativeOutputTokens = 0

    const contextLimit = getContextWindow(conv.model) ?? 200_000

    const emit = (event: AgentEvent) => {
      dlog('emit', event.type, event)
      if (event.type === 'turn_complete') {
        cumulativeInputTokens += event.usage.inputTokens
        cumulativeOutputTokens += event.usage.outputTokens
      }
      // Prefer the invoking webContents; fall back to any live window if the
      // original was destroyed (e.g. window closed mid-run).
      let target: WebContents | null = null
      if (sender && !sender.isDestroyed()) {
        target = sender
      } else {
        const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
        const win = wins.find(w => w.webContents && !w.webContents.isDestroyed())
        target = win?.webContents ?? null
      }
      if (target) {
        try {
          target.send('agent:event', event)
        } catch (err) {
          if (DEBUG) console.error('[wos:runner] emit failed', err)
        }
      } else if (DEBUG) {
        console.warn('[wos:runner] no live window — dropping event', event.type)
      }
      if (event.type === 'turn_complete') turnCompleteEmitted = true
      this.mergeEventIntoBlocks(assistantBlocks, event)
    }

    let agentSettings: Awaited<ReturnType<typeof resolveAgent>> | null = null
    let memoryEnabled = true

    try {
      agentSettings = await resolveAgent(conv.agentKey ?? 'wos')
      const reasoningEffort = readAgentReasoningEffort(agentSettings)
      const intentAgentSettings = await resolveAgent('intent').catch(() => null)
      const intentModel = (intentAgentSettings?.model as string | undefined) || 'claude-haiku-4-5-20251001'
      const intentApiKeyOverride = intentAgentSettings?.apiKeyOverride
      const compactionAgentSettings = await resolveAgent('compaction').catch(() => null)
      const compactionModel = compactionAgentSettings?.model as string | undefined
      const compactionApiKeyOverride = compactionAgentSettings?.apiKeyOverride
      const intentEnabledRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'intentEnabled')).get()
      const intentEnabled = intentEnabledRow ? (intentEnabledRow.value as boolean) !== false : true
      const memoryEnabledRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'memoryEnabled')).get()
      memoryEnabled = memoryEnabledRow ? (memoryEnabledRow.value as boolean) !== false : true

      // Inject relevant memories into the system prompt
      let memoryAppend = ''
      if (memoryEnabled) {
        try {
          const memories = recallMemories(fullUserMessage, 5)
          memoryAppend = buildMemoryBlock(memories)
        } catch { /* non-fatal */ }
      }

      const baseCustom = (agentSettings!.systemPrompt || '').trim()
      const customPrompt = baseCustom || undefined
      const appendContext = memoryAppend || undefined

      // Resolve the API key against the conversation's model (the model the
      // user actually picked in chat), not the WOS agent's configured model.
      // Otherwise selecting a runpod model in chat while the WOS agent is
      // configured for OpenAI (or vice versa) sends the wrong key → 401.
      const convApiKeyOverride = await resolveApiKeyForModel(conv.model)
        .catch(() => undefined)
      const effectiveApiKeyOverride = (convApiKeyOverride && convApiKeyOverride.length > 0)
        ? convApiKeyOverride
        : agentSettings!.apiKeyOverride

      for await (const event of queryLoop({
        model: conv.model,
        messages: history,
        userMessage: fullUserMessage,
        workspacePath,
        mode: conv.mode as AgentMode,
        reasoningEffort,
        systemPromptCustom: customPrompt,
        apiKeyOverride: effectiveApiKeyOverride,
        signal,
        permissionStore: this.permissionStore,
        onPermissionRequest: (toolName, toolId, args) =>
          this.requestPermission(toolName, toolId, args, emit),
        onAskUser: (question, questionId, choices, extras) =>
          this.askUser(question, questionId, choices, emit, extras),
        onEvent: emit,
        conversationId,
        contextLimit,
        intentModel,
        intentApiKeyOverride,
        compactionModel,
        compactionApiKeyOverride,
        skipIntent: !intentEnabled,
        systemPromptAppend: appendContext,
      })) {
        if (signal.aborted) break
        emit(event)
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        const msg = err instanceof Error ? err.message : String(err)
        dlog('queryLoop threw:', msg)
        emit({ type: 'error', message: msg, retryable: this.isRetryable(err) })
      }
    } finally {
      // ALWAYS flush a terminal event so the renderer spinner cannot hang.
      if (!turnCompleteEmitted) {
        emit({ type: 'turn_complete', usage: { inputTokens: 0, outputTokens: 0 } })
      }

      // Extract and persist facts from this turn (non-blocking, non-fatal)
      if (memoryEnabled && cumulativeOutputTokens > 0) {
        const assistantText = assistantBlocks
          .filter(b => b.type === 'text')
          .map(b => (typeof b.content === 'string' ? b.content : ''))
          .join('')
        ;(async () => {
          const fa = await resolveAgent('factExtractor').catch(() => null)
          const fxModel = (fa?.model as string | undefined) || conv.model
          const fxKey = fa?.apiKeyOverride ?? agentSettings?.apiKeyOverride
          return extractAndStoreFacts(fullUserMessage, assistantText, fxModel, fxKey)
        })()
          .then(() => pruneOldMemories(1000))
          .catch(() => { /* non-fatal */ })
      }

      // Save assistant message
      if (assistantBlocks.length > 0) {
        db.insert(schema.messages).values({
          id: assistantMsgId,
          conversationId,
          role: 'assistant',
          blocks: JSON.stringify(assistantBlocks),
          createdAt: new Date(),
        }).run()

        // Update conversation: title (first message), token count, context limit
        const existingConv = db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()
        const prevTokenCount = existingConv?.tokenCount ?? 0
        const convUpdate: Record<string, unknown> = {
          updatedAt: new Date(),
          tokenCount: prevTokenCount + cumulativeInputTokens + cumulativeOutputTokens,
          contextLimit,
        }
        if (activeMsgRows.length === 0 && userMessage.length > 0) {
          convUpdate.title = userMessage.slice(0, 60) + (userMessage.length > 60 ? '…' : '')
        }
        db.update(schema.conversations)
          .set(convUpdate as unknown as Partial<typeof schema.conversations.$inferInsert>)
          .where(eq(schema.conversations.id, conversationId))
          .run()
        notifyWrite()
      }

      this.abortController = null
    }
  }

  // Continue a conversation from the last saved user message (e.g. after an edit).
  // Does NOT create a new user message — it finds the last user message in the DB
  // (filtered to the highest branch), uses it as the prompt, and saves the
  // assistant response tagged with the same branchGroupId/branchIndex.
  async continue(conversationId: string, sender?: WebContents) {
    this.abortController = new AbortController()
    const { signal } = this.abortController

    const db = getDb()

    const conv = db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get()
    if (!conv) throw new Error(`Conversation ${conversationId} not found`)

    let workspacePath: string | null = null
    if (conv.workspaceId) {
      const ws = db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, conv.workspaceId))
        .get()
      workspacePath = ws?.path ?? null
    }

    const msgRows = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.createdAt))
      .all()

    // Filter to highest branchIndex per group
    const maxBranchPerGroup: Record<string, number> = {}
    for (const m of msgRows) {
      if (m.branchGroupId) {
        const cur = maxBranchPerGroup[m.branchGroupId] ?? 0
        maxBranchPerGroup[m.branchGroupId] = Math.max(cur, m.branchIndex ?? 0)
      }
    }
    const activeMsgs = msgRows.filter(m => {
      if (!m.branchGroupId) return true
      return (m.branchIndex ?? 0) === maxBranchPerGroup[m.branchGroupId]
    })

    const lastMsg = activeMsgs[activeMsgs.length - 1]
    if (!lastMsg || lastMsg.role !== 'user') {
      throw new Error('No user message to continue from')
    }

    // Extract the user message text
    const lastBlocks = (lastMsg.blocks as MessageBlock[]) ?? []
    const userMessage = lastBlocks
      .filter(b => b.type === 'text')
      .map(b => (typeof b.content === 'string' ? b.content : ''))
      .join('')

    // Build history from all messages except the last user message
    const historyMsgs = activeMsgs.slice(0, -1)
    const history: ConversationMessage[] = []
    for (const m of historyMsgs) {
      const blocks = (m.blocks as MessageBlock[]) ?? []
      const role = m.role as 'user' | 'assistant'
      const textParts: string[] = []
      const blockContent: ContentBlock[] = []
      const toolResults: ContentBlock[] = []

      for (const b of blocks) {
        if (b.type === 'text') {
          const s = typeof b.content === 'string' ? b.content : ''
          if (s) {
            textParts.push(s)
            blockContent.push({ type: 'text', text: s })
          }
        } else if (b.type === 'tool_use') {
          blockContent.push({
            type: 'tool_use',
            id: b.toolId as string,
            name: b.toolName as string,
            input: (b.input ?? {}) as unknown,
          })
          if ('result' in b || 'error' in b) {
            const resultStr = b.error
              ? `Error: ${String(b.error)}`
              : typeof b.result === 'string'
                ? b.result
                : JSON.stringify(b.result ?? null)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: b.toolId as string,
              content: resultStr,
            })
          }
        }
      }

      if (role === 'assistant' && blockContent.length > 0) {
        const onlyText = blockContent.every(b => b.type === 'text')
        history.push({
          role: 'assistant',
          content: onlyText ? textParts.join('') : blockContent,
        })
        if (toolResults.length > 0) {
          history.push({ role: 'user', content: toolResults })
        }
      } else if (role === 'user') {
        const joined = textParts.join('')
        if (joined) history.push({ role: 'user', content: joined })
      }
    }

    const assistantBlocks: MessageBlock[] = []
    const assistantMsgId = randomUUID()
    let turnCompleteEmitted = false
    let cumulativeInputTokens = 0
    let cumulativeOutputTokens = 0

    const contextLimit = getContextWindow(conv.model) ?? 200_000

    const emit = (event: AgentEvent) => {
      dlog('emit', event.type, event)
      if (event.type === 'turn_complete') {
        cumulativeInputTokens += event.usage.inputTokens
        cumulativeOutputTokens += event.usage.outputTokens
      }
      let target: WebContents | null = null
      if (sender && !sender.isDestroyed()) {
        target = sender
      } else {
        const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
        const win = wins.find(w => w.webContents && !w.webContents.isDestroyed())
        target = win?.webContents ?? null
      }
      if (target) {
        try {
          target.send('agent:event', event)
        } catch (err) {
          if (DEBUG) console.error('[wos:runner] emit failed', err)
        }
      }
      if (event.type === 'turn_complete') turnCompleteEmitted = true
      this.mergeEventIntoBlocks(assistantBlocks, event)
    }

    let agentSettings2: Awaited<ReturnType<typeof resolveAgent>> | null = null
    let memEnabled2 = true

    try {
      agentSettings2 = await resolveAgent(conv.agentKey ?? 'wos')
      const reasoningEffort = readAgentReasoningEffort(agentSettings2)
      const intentAgentSettings2 = await resolveAgent('intent').catch(() => null)
      const intentModel2 = (intentAgentSettings2?.model as string | undefined) || 'claude-haiku-4-5-20251001'
      const intentApiKeyOverride2 = intentAgentSettings2?.apiKeyOverride
      const compactionAgentSettings2 = await resolveAgent('compaction').catch(() => null)
      const compactionModel2 = compactionAgentSettings2?.model as string | undefined
      const compactionApiKeyOverride2 = compactionAgentSettings2?.apiKeyOverride
      const intentEnabledRow2 = db.select().from(schema.settings).where(eq(schema.settings.key, 'intentEnabled')).get()
      const intentEnabled2 = intentEnabledRow2 ? (intentEnabledRow2.value as boolean) !== false : true
      const memEnabledRow2 = db.select().from(schema.settings).where(eq(schema.settings.key, 'memoryEnabled')).get()
      memEnabled2 = memEnabledRow2 ? (memEnabledRow2.value as boolean) !== false : true
      let memAppend2 = ''
      if (memEnabled2) {
        try {
          const mems = recallMemories(userMessage, 5)
          memAppend2 = buildMemoryBlock(mems)
        } catch { /* non-fatal */ }
      }
      const baseCustom = (agentSettings2!.systemPrompt || '').trim()
      const customPrompt = baseCustom || undefined
      const appendContext2 = memAppend2 || undefined

      // Resolve API key against conv.model (see comment in primary run path).
      const convApiKeyOverride2 = await resolveApiKeyForModel(conv.model)
        .catch(() => undefined)
      const effectiveApiKeyOverride2 = (convApiKeyOverride2 && convApiKeyOverride2.length > 0)
        ? convApiKeyOverride2
        : agentSettings2!.apiKeyOverride

      for await (const event of queryLoop({
        model: conv.model,
        messages: history,
        userMessage,
        workspacePath,
        mode: conv.mode as AgentMode,
        reasoningEffort,
        systemPromptCustom: customPrompt,
        apiKeyOverride: effectiveApiKeyOverride2,
        signal,
        permissionStore: this.permissionStore,
        onPermissionRequest: (toolName, toolId, args) =>
          this.requestPermission(toolName, toolId, args, emit),
        onAskUser: (question, questionId, choices, extras) =>
          this.askUser(question, questionId, choices, emit, extras),
        onEvent: emit,
        conversationId,
        contextLimit,
        intentModel: intentModel2,
        intentApiKeyOverride: intentApiKeyOverride2,
        compactionModel: compactionModel2,
        compactionApiKeyOverride: compactionApiKeyOverride2,
        skipIntent: !intentEnabled2,
        systemPromptAppend: appendContext2,
      })) {
        if (signal.aborted) break
        emit(event)
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        const msg = err instanceof Error ? err.message : String(err)
        dlog('queryLoop threw:', msg)
        emit({ type: 'error', message: msg, retryable: this.isRetryable(err) })
      }
    } finally {
      if (!turnCompleteEmitted) {
        emit({ type: 'turn_complete', usage: { inputTokens: 0, outputTokens: 0 } })
      }

      // Extract and persist facts from this turn (non-blocking, non-fatal)
      if (memEnabled2 && cumulativeOutputTokens > 0) {
        const assistantText2 = assistantBlocks
          .filter(b => b.type === 'text')
          .map(b => (typeof b.content === 'string' ? b.content : ''))
          .join('')
        ;(async () => {
          const fa = await resolveAgent('factExtractor').catch(() => null)
          const fxModel = (fa?.model as string | undefined) || conv.model
          const fxKey = fa?.apiKeyOverride ?? agentSettings2?.apiKeyOverride
          return extractAndStoreFacts(userMessage, assistantText2, fxModel, fxKey)
        })()
          .then(() => pruneOldMemories(1000))
          .catch(() => { /* non-fatal */ })
      }

      if (assistantBlocks.length > 0) {
        db.insert(schema.messages).values({
          id: assistantMsgId,
          conversationId,
          role: 'assistant',
          blocks: JSON.stringify(assistantBlocks),
          createdAt: new Date(),
          branchGroupId: lastMsg.branchGroupId ?? undefined,
          branchIndex: lastMsg.branchIndex ?? 0,
        }).run()

        const existingConv2 = db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()
        const prevCount2 = existingConv2?.tokenCount ?? 0
        db.update(schema.conversations)
          .set({
            updatedAt: new Date(),
            tokenCount: prevCount2 + cumulativeInputTokens + cumulativeOutputTokens,
            contextLimit,
          } as unknown as Partial<typeof schema.conversations.$inferInsert>)
          .where(eq(schema.conversations.id, conversationId))
          .run()
        notifyWrite()
      } else if (lastMsg.branchGroupId) {
        // The user message we continued from was edited (it lives in a branch
        // group). Even though this turn produced no assistant blocks (cancelled,
        // errored, no model output), persist a stub assistant message so the
        // branch is anchored — otherwise the next edit lookup would see an
        // unbalanced branch and the picker would render a phantom slot.
        db.insert(schema.messages).values({
          id: assistantMsgId,
          conversationId,
          role: 'assistant',
          blocks: JSON.stringify([]),
          createdAt: new Date(),
          branchGroupId: lastMsg.branchGroupId,
          branchIndex: lastMsg.branchIndex ?? 0,
        }).run()
        notifyWrite()
      }

      this.abortController = null
    }
  }

  cancel() {
    this.abortController?.abort()
    // Unblock any pending permission/ask Promises so queryLoop can exit
    for (const [, resolver] of this.pauseResolvers) {
      try { resolver('deny') } catch { /* ignore */ }
    }
    this.pauseResolvers.clear()
    for (const [, entry] of this.askUserResolvers) {
      try { entry.resolve('__cancelled__') } catch { /* ignore */ }
    }
    this.askUserResolvers.clear()
  }

  resolveAnswer(id: string, answer: string) {
    // Check ask_user resolvers first — these emit ask_user_answered before resolving
    const askEntry = this.askUserResolvers.get(id)
    if (askEntry) {
      try { askEntry.emit({ type: 'ask_user_answered', questionId: id, answer }) } catch { /* ignore */ }
      askEntry.resolve(answer)
      this.askUserResolvers.delete(id)
      return
    }
    const resolver = this.pauseResolvers.get(id)
    if (resolver) {
      resolver(answer)
      this.pauseResolvers.delete(id)
    }
  }

  resetSessionPermissions() {
    this.permissionStore.clear()
  }

  private async requestPermission(
    toolName: string,
    toolId: string,
    args: unknown,
    emit: (e: AgentEvent) => void,
  ): Promise<'allow' | 'allow-session' | 'deny'> {
    const decision = await new Promise<'allow' | 'allow-session' | 'deny'>(resolve => {
      emit({ type: 'permission_request', toolName, toolId, args })
      this.pauseResolvers.set(toolId, resolve as (v: string) => void)
    })
    emit({ type: 'permission_decided', toolId, decision: decision === 'deny' ? 'denied' : 'allowed' })
    return decision
  }

  private async askUser(
    question: string,
    questionId: string,
    choices: string[] | undefined,
    emit: (e: AgentEvent) => void,
    extras?: import('../../../src/types').AskUserExtras,
  ): Promise<string> {
    return new Promise(resolve => {
      emit({ type: 'ask_user', question, questionId, choices, extras })
      this.askUserResolvers.set(questionId, { resolve, emit })
    })
  }

  private mergeEventIntoBlocks(blocks: MessageBlock[], event: AgentEvent) {
    switch (event.type) {
      case 'text_delta': {
        const last = blocks[blocks.length - 1]
        if (last?.type === 'text') {
          last.content = (last.content as string) + event.content
        } else {
          blocks.push({ type: 'text', content: event.content })
        }
        break
      }
      case 'reasoning_delta': {
        const last = blocks[blocks.length - 1]
        if (last?.type === 'reasoning') {
          last.content = (last.content as string) + event.content
        } else {
          blocks.push({ type: 'reasoning', content: event.content })
        }
        break
      }
      case 'tool_preparing':
        blocks.push({
          type: 'tool_use',
          toolName: event.toolName,
          toolId: event.toolId,
          input: {},
          partialArgs: '',
          status: 'preparing',
        })
        break
      case 'tool_arg_delta': {
        const block = blocks.find(b => b.type === 'tool_use' && b.toolId === event.toolId)
        if (block) block.partialArgs = (block.partialArgs ?? '') + event.delta
        break
      }
      case 'tool_use_start': {
        const existing = blocks.find(b => b.type === 'tool_use' && b.toolId === event.toolId)
        if (existing) {
          existing.input = event.input
          existing.status = 'running'
          delete existing.partialArgs
        } else {
          blocks.push({
            type: 'tool_use',
            toolName: event.toolName,
            toolId: event.toolId,
            input: event.input,
            status: 'running',
          })
        }
        break
      }
      case 'tool_result': {
        const block = blocks.find(
          b => b.type === 'tool_use' && b.toolId === event.toolId
        )
        if (block) {
          block.status = event.error ? 'error' : 'done'
          block.result = event.result
          block.error = event.error
        }
        break
      }
      case 'permission_request':
        blocks.push({
          type: 'permission_request',
          toolName: event.toolName,
          toolId: event.toolId,
          args: event.args,
        })
        break
      case 'permission_decided': {
        const block = blocks.find(
          b => b.type === 'permission_request' && b.toolId === event.toolId
        )
        if (block) block.decision = event.decision
        break
      }
      case 'ask_user':
        blocks.push({
          type: 'ask_user',
          question: event.question,
          questionId: event.questionId,
          choices: event.choices,
        })
        break
      case 'ask_user_answered': {
        const block = blocks.find(b => b.type === 'ask_user' && b.questionId === event.questionId)
        if (block) block.answer = event.answer
        break
      }
      case 'subagent_start':
        blocks.push({
          type: 'subagent',
          agentId: event.agentId,
          prompt: event.prompt,
          events: [],
          collapsed: false,
        })
        break
      case 'subagent_event': {
        const block = blocks.find(
          b => b.type === 'subagent' && b.agentId === event.agentId
        )
        if (block) {
          const events = Array.isArray(block.events) ? block.events : []
          block.events = [...events, event.event]
        }
        break
      }
      case 'subagent_end': {
        const block = blocks.find(
          b => b.type === 'subagent' && b.agentId === event.agentId
        )
        if (block) {
          block.result = event.result
          block.collapsed = true
        }
        break
      }
      case 'turn_complete':
        // Mark any open reasoning blocks as done so finalizeOrphanBlocks does
        // not incorrectly flag them as interrupted when the chat is revisited.
        for (const b of blocks) {
          if (b.type === 'reasoning' && !b.done) b.done = true
        }
        break
      case 'compact_complete':
        if (event.summary) {
          blocks.push({ type: 'compact_notice', summary: event.summary })
        }
        break
      case 'error':
        blocks.push({ type: 'error', message: event.message, retryable: event.retryable })
        break
    }
  }

  private isRetryable(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return msg.includes('rate_limit') || msg.includes('429') || msg.includes('network') ||
      msg.includes('timeout') || msg.includes('econnrefused')
  }
}

export const agentRunner = new AgentRunner()
