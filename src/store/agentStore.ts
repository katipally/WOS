import { create } from 'zustand'
import type { AgentEvent, Conversation, DisplayMessage, MessageBlock, FileAttachment } from '../types'
import { applyEvent, finalizeOrphanBlocks } from '../lib/blockAccumulator'
import { eventLog } from '../lib/eventLog'
import { toast } from 'sonner'
import { useWorkspaceStore } from './workspaceStore'

interface ConversationStream {
  assistantMsgId: string
  blocks: MessageBlock[]
  isStreaming: boolean
  sendToken: number
}

interface AgentStore {
  isStreaming: boolean
  activeConversationId: string | null
  conversations: Conversation[]
  currentMessages: DisplayMessage[]
  /**
   * Per-conversation in-flight stream buffer. Survives tab switches —
   * when the user navigates away from a streaming conversation, events
   * keep filling streams[convId]; on return, loadConversation merges
   * the buffer with persisted DB blocks so the UI reflects live state.
   */
  streams: Record<string, ConversationStream>
  activeBranches: Record<string, number>  // branchGroupId → active branch index
  currentMode: string
  currentModel: string
  sessionTokens: { input: number; output: number }
  sendToken: number
  loadToken: number
  /** Currently focused subagent id (from /subagents focus or header click). null = unfocused. */
  focusedAgentId: string | null

  loadConversations: () => Promise<void>
  loadConversation: (id: string) => Promise<void>
  startNewConversation: (workspaceId?: string | null) => Promise<string>
  sendMessage: (text: string, attachments?: FileAttachment[]) => Promise<void>
  continueConversation: () => Promise<void>
  cancelAgent: () => void
  answerQuestion: (questionId: string, answer: string) => void
  grantPermission: (toolId: string, scope: 'allow' | 'allow-session') => void
  denyPermission: (toolId: string) => void
  deleteConversation: (id: string) => Promise<void>
  retryLastMessage: () => Promise<void>
  setMode: (mode: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setActiveConversationId: (id: string | null) => void
  setConversationWorkspace: (convId: string, workspaceId: string | null) => Promise<void>
  renameConversation: (convId: string, title: string) => Promise<void>
  editMessage: (messageId: string, newText: string) => Promise<void>
  switchBranch: (branchGroupId: string, newIndex: number) => void
  setFocusedAgentId: (id: string | null) => void
}

let agentEventCleanup: (() => void) | null = null

export const useAgentStore = create<AgentStore>((set, get) => ({
  isStreaming: false,
  activeConversationId: null,
  conversations: [],
  currentMessages: [],
  streams: {},
  activeBranches: {},
  currentMode: 'default',
  currentModel: '',
  sessionTokens: { input: 0, output: 0 },
  sendToken: 0,
  loadToken: 0,
  focusedAgentId: null,

  setFocusedAgentId: (id: string | null) => set({ focusedAgentId: id }),

  loadConversations: async () => {
    try {
      const convs = await window.wos.getConversations() as Conversation[]
      set({ conversations: convs })
    } catch (err) {
      console.error('[wos:store] loadConversations failed', err)
    }
  },

  loadConversation: async (id: string) => {
    const token = get().loadToken + 1
    set({ loadToken: token })
    try {
      const messages = await window.wos.getMessages(id) as Array<{
        id: string
        role: string
        blocks: MessageBlock[]
        createdAt: string
        branchGroupId?: string | null
        branchIndex?: number | null
      }>

      const conv = await window.wos.getConversation(id) as Conversation

      // If a newer load started after us, or the user switched convs, ignore results
      if (get().loadToken !== token) return

      // Find the index of the last assistant message — only that one can show the
      // "run was interrupted" banner; older messages are silently cleaned up.
      const lastAssistantIdx = messages.reduce(
        (best, m, i) => (m.role === 'assistant' ? i : best),
        -1
      )

      const displayMessages: DisplayMessage[] = messages.map((m, idx) => {
        const rawBlocks: MessageBlock[] = Array.isArray(m.blocks)
          ? m.blocks
          : JSON.parse(m.blocks as unknown as string)
        const isLatestAssistant = m.role === 'assistant' && idx === lastAssistantIdx
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          blocks: finalizeOrphanBlocks(rawBlocks, { isLatestMessage: isLatestAssistant }),
          createdAt: new Date(m.createdAt),
          branchGroupId: m.branchGroupId,
          branchIndex: m.branchIndex,
        }
      })

      // Merge in any in-flight stream buffer for this conversation so
      // tab-switching back into a still-streaming conv shows live state.
      const buf = get().streams[id]
      if (buf) {
        const persistedIds = new Set(displayMessages.map(m => m.id))
        if (!persistedIds.has(buf.assistantMsgId) && buf.blocks.length > 0) {
          displayMessages.push({
            id: buf.assistantMsgId,
            role: 'assistant',
            blocks: buf.blocks,
            createdAt: new Date(),
          })
        }
        // If the stream completed while away, the DB already has the final
        // version — drop the buffer entry on next tick.
        if (!buf.isStreaming) {
          setTimeout(() => {
            set(s => {
              const next = { ...s.streams }
              delete next[id]
              return { streams: next }
            })
          }, 0)
        }
      }

      // Build activeBranches: default to highest branch index per group
      const activeBranches: Record<string, number> = {}
      for (const m of displayMessages) {
        if (m.branchGroupId) {
          const cur = activeBranches[m.branchGroupId] ?? 0
          activeBranches[m.branchGroupId] = Math.max(cur, m.branchIndex ?? 0)
        }
      }

      // Only update activeConversationId if caller intent still matches
      set({
        activeConversationId: id,
        currentMessages: displayMessages,
        activeBranches,
        currentMode: conv?.mode ?? get().currentMode,
        currentModel: conv?.model ?? get().currentModel,
        // Reflect any in-flight stream's status for this conv into the
        // global isStreaming flag so the composer/spinner state is correct.
        isStreaming: buf?.isStreaming ?? false,
      })

      // Sync active workspace to match the loaded conversation's workspace
      if (conv?.workspaceId !== undefined) {
        void useWorkspaceStore.getState().setActiveWorkspace(conv.workspaceId)
      }
    } catch (err) {
      console.error('[wos:store] loadConversation failed', err)
      toast.error('Failed to load conversation')
    }
  },

  startNewConversation: async (workspaceId?: string | null) => {
    const { currentModel, currentMode } = get()
    const conv = await window.wos.createConversation({
      workspaceId: workspaceId ?? undefined,
      model: currentModel,
      mode: currentMode,
    }) as Conversation

    set(s => ({
      conversations: [conv, ...s.conversations],
      activeConversationId: conv.id,
      currentMessages: [],
    }))

    return conv.id
  },

  sendMessage: async (text: string, attachments = []) => {
    let { activeConversationId } = get()
    console.log('[wos:store] sendMessage called', { text: text.slice(0, 40), activeConversationId, isStreaming: get().isStreaming })
    if (!activeConversationId) {
      console.log('[wos:store] no active conversation — creating one')
      try {
        activeConversationId = await get().startNewConversation()
      } catch (err) {
        console.error('[wos:store] failed to auto-create conversation', err)
        toast.error('Failed to start conversation')
        return
      }
    }
    if (get().isStreaming) {
      console.warn('[wos:store] sendMessage ignored — already streaming')
      return
    }

    // Per-send token — late async events from prior sends will be ignored
    const sendToken = get().sendToken + 1
    const targetConvId = activeConversationId
    set({ sendToken })

    const { currentModel, currentMode } = get()
    try {
      await window.wos.updateConversation(targetConvId, {
        model: currentModel,
        mode: currentMode,
      })
    } catch (err) {
      console.error('[wos:store] failed to sync conversation settings', err)
      toast.error('Failed to update conversation settings')
      return
    }

    // Optimistically add user message to UI
    const userMsgId = `user-${Date.now()}`
    const userMsg: DisplayMessage = {
      id: userMsgId,
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      createdAt: new Date(),
    }

    const assistantMsgId = `assistant-${Date.now()}`
    const assistantMsg: DisplayMessage = {
      id: assistantMsgId,
      role: 'assistant',
      blocks: [],
      createdAt: new Date(),
    }

    set(s => ({
      isStreaming: true,
      currentMessages: [...s.currentMessages, userMsg, assistantMsg],
    }))

    // Setup event listener — tear down prior one first
    if (agentEventCleanup) agentEventCleanup()
    // Seed the buffer for this conv before any events arrive
    set(s => ({
      streams: {
        ...s.streams,
        [targetConvId]: { assistantMsgId, blocks: [], isStreaming: true, sendToken },
      },
    }))
    agentEventCleanup = window.wos.onAgentEvent((event: unknown) => {
      const e = event as AgentEvent
      eventLog.push(e)
      if (typeof window !== 'undefined' && (window as unknown as { WOS_DEBUG?: boolean }).WOS_DEBUG) {
        console.log('[wos:event]', e.type, e)
      }

      // Handle focus events independently — they don't touch blocks
      if (e.type === 'subagent_focus') {
        set({ focusedAgentId: e.agentId })
        return
      }

      // Ignore stale events from a superseded send for THIS conv
      const buf = get().streams[targetConvId]
      if (!buf || buf.sendToken !== sendToken) return

      const completed = e.type === 'turn_complete' || e.type === 'error'
      const newBlocks = applyEvent(buf.blocks, e)

      set(s => {
        const streams = {
          ...s.streams,
          [targetConvId]: {
            ...buf,
            blocks: newBlocks,
            isStreaming: !completed,
          },
        }

        // Only patch currentMessages / global UI state if the user is
        // currently looking at this conversation. Otherwise the event
        // is buffered silently and merged on next loadConversation.
        if (s.activeConversationId !== targetConvId) {
          return { ...s, streams }
        }

        const msgs = [...s.currentMessages]
        const idx = msgs.findIndex(m => m.id === assistantMsgId)
        if (idx < 0) return { ...s, streams }
        const lastMsg = msgs[idx]
        if (lastMsg.role !== 'assistant') return { ...s, streams }
        msgs[idx] = { ...lastMsg, blocks: newBlocks }

        if (completed) {
          const nextTokens = e.type === 'turn_complete'
            ? {
                input: s.sessionTokens.input + (e.usage?.inputTokens ?? 0),
                output: s.sessionTokens.output + (e.usage?.outputTokens ?? 0),
              }
            : s.sessionTokens
          return { ...s, streams, isStreaming: false, currentMessages: msgs, sessionTokens: nextTokens }
        }
        return { ...s, streams, currentMessages: msgs }
      })
    })

    try {
      console.log('[wos:store] invoking IPC agent:send')
      const result = await window.wos.sendMessage({
        conversationId: targetConvId,
        message: text,
        attachments,
      }) as { success: boolean; error?: string }
      console.log('[wos:store] IPC agent:send returned', result)
      if (result && result.success === false) {
        toast.error(`Error: ${result.error ?? 'Unknown error'}`)
        set(s => {
          const buf = s.streams[targetConvId]
          const streams = buf
            ? { ...s.streams, [targetConvId]: { ...buf, isStreaming: false } }
            : s.streams
          return {
            streams,
            isStreaming: s.activeConversationId === targetConvId ? false : s.isStreaming,
          }
        })
      }
    } catch (err) {
      console.error('[wos:store] sendMessage IPC error', err)
      toast.error(`Error: ${(err as Error).message}`)
      set(s => {
        const buf = s.streams[targetConvId]
        const streams = buf
          ? { ...s.streams, [targetConvId]: { ...buf, isStreaming: false } }
          : s.streams
        return {
          streams,
          isStreaming: s.activeConversationId === targetConvId ? false : s.isStreaming,
        }
      })
    } finally {
      // Refresh sidebar list (titles, updatedAt) — cheap, no currentMessages clobber
      void get().loadConversations()
    }
  },

  continueConversation: async () => {
    const { activeConversationId } = get()
    if (!activeConversationId || get().isStreaming) return

    const sendToken = get().sendToken + 1
    const targetConvId = activeConversationId
    set({ sendToken })

    const { currentModel, currentMode } = get()
    try {
      await window.wos.updateConversation(targetConvId, {
        model: currentModel,
        mode: currentMode,
      })
    } catch (err) {
      console.error('[wos:store] failed to sync conversation settings', err)
      toast.error('Failed to update conversation settings')
      return
    }

    const assistantMsgId = `assistant-${Date.now()}`
    const assistantMsg: DisplayMessage = {
      id: assistantMsgId,
      role: 'assistant',
      blocks: [],
      createdAt: new Date(),
    }
    set(s => ({
      isStreaming: true,
      currentMessages: [...s.currentMessages, assistantMsg],
      streams: {
        ...s.streams,
        [targetConvId]: { assistantMsgId, blocks: [], isStreaming: true, sendToken },
      },
    }))

    if (agentEventCleanup) agentEventCleanup()
    agentEventCleanup = window.wos.onAgentEvent((event: unknown) => {
      const e = event as AgentEvent
      eventLog.push(e)

      // Handle focus events independently — they don't touch blocks
      if (e.type === 'subagent_focus') {
        set({ focusedAgentId: e.agentId })
        return
      }

      const buf = get().streams[targetConvId]
      if (!buf || buf.sendToken !== sendToken) return

      const completed = e.type === 'turn_complete' || e.type === 'error'
      const newBlocks = applyEvent(buf.blocks, e)

      set(s => {
        const streams = {
          ...s.streams,
          [targetConvId]: { ...buf, blocks: newBlocks, isStreaming: !completed },
        }
        if (s.activeConversationId !== targetConvId) {
          return { ...s, streams }
        }
        const msgs = [...s.currentMessages]
        const idx = msgs.findIndex(m => m.id === assistantMsgId)
        if (idx < 0) return { ...s, streams }
        const lastMsg = msgs[idx]
        if (lastMsg.role !== 'assistant') return { ...s, streams }
        msgs[idx] = { ...lastMsg, blocks: newBlocks }
        if (completed) {
          const nextTokens = e.type === 'turn_complete'
            ? { input: s.sessionTokens.input + (e.usage?.inputTokens ?? 0), output: s.sessionTokens.output + (e.usage?.outputTokens ?? 0) }
            : s.sessionTokens
          return { ...s, streams, isStreaming: false, currentMessages: msgs, sessionTokens: nextTokens }
        }
        return { ...s, streams, currentMessages: msgs }
      })
    })

    try {
      const result = await window.wos.continueConversation(targetConvId) as { success: boolean; error?: string }
      if (result && result.success === false) {
        toast.error(`Error: ${result.error ?? 'Unknown error'}`)
        set(s => {
          const buf = s.streams[targetConvId]
          const streams = buf
            ? { ...s.streams, [targetConvId]: { ...buf, isStreaming: false } }
            : s.streams
          return {
            streams,
            isStreaming: s.activeConversationId === targetConvId ? false : s.isStreaming,
          }
        })
      }
    } catch (err) {
      console.error('[wos:store] continueConversation IPC error', err)
      toast.error(`Error: ${(err as Error).message}`)
      set(s => {
        const buf = s.streams[targetConvId]
        const streams = buf
          ? { ...s.streams, [targetConvId]: { ...buf, isStreaming: false } }
          : s.streams
        return {
          streams,
          isStreaming: s.activeConversationId === targetConvId ? false : s.isStreaming,
        }
      })
    } finally {
      void get().loadConversations()
    }
  },

  cancelAgent: () => {
    window.wos.cancelAgent()
    const { activeConversationId } = get()
    set(s => {
      if (!activeConversationId) return { isStreaming: false }
      const buf = s.streams[activeConversationId]
      const streams = buf
        ? { ...s.streams, [activeConversationId]: { ...buf, isStreaming: false } }
        : s.streams
      return { isStreaming: false, streams }
    })
  },

  answerQuestion: (questionId: string, answer: string) => {
    window.wos.answerQuestion(questionId, answer)
    // Update the ask_user block to show the answer
    set(s => ({
      currentMessages: s.currentMessages.map(m => ({
        ...m,
        blocks: m.blocks.map(b =>
          b.type === 'ask_user' && b.questionId === questionId
            ? { ...b, answer }
            : b
        ),
      })),
    }))
  },

  grantPermission: (toolId: string, scope: 'allow' | 'allow-session') => {
    window.wos.grantPermission(toolId, scope === 'allow' ? 'allow' : 'allow-session')
    set(s => ({
      currentMessages: s.currentMessages.map(m => ({
        ...m,
        blocks: m.blocks.map(b =>
          b.type === 'permission_request' && b.toolId === toolId
            ? { ...b, decision: 'allowed' as const }
            : b
        ),
      })),
    }))
  },

  denyPermission: (toolId: string) => {
    window.wos.grantPermission(toolId, 'deny')
    set(s => ({
      currentMessages: s.currentMessages.map(m => ({
        ...m,
        blocks: m.blocks.map(b =>
          b.type === 'permission_request' && b.toolId === toolId
            ? { ...b, decision: 'denied' as const }
            : b
        ),
      })),
    }))
  },

  deleteConversation: async (id: string) => {
    await window.wos.deleteConversation(id)
    set(s => {
      const next = s.conversations.filter(c => c.id !== id)
      const newActive = s.activeConversationId === id ? null : s.activeConversationId
      const streams = { ...s.streams }
      delete streams[id]
      return {
        conversations: next,
        activeConversationId: newActive,
        currentMessages: newActive === null ? [] : s.currentMessages,
        streams,
      }
    })
    toast.success('Conversation deleted')
  },

  retryLastMessage: async () => {
    const { currentMessages, sendMessage } = get()
    const lastUser = [...currentMessages].reverse().find(m => m.role === 'user')
    if (!lastUser) return
    const text = lastUser.blocks.find(b => b.type === 'text')?.content as string ?? ''
    if (text) await sendMessage(text)
  },

  setMode: async (mode: string) => {
    const { activeConversationId } = get()
    set(s => ({
      currentMode: mode,
      conversations: s.conversations.map(c =>
        c.id === activeConversationId ? { ...c, mode: mode as Conversation['mode'] } : c
      ),
    }))
    if (activeConversationId) {
      await window.wos.updateConversation(activeConversationId, { mode })
    }
  },

  setModel: async (model: string) => {
    const { activeConversationId } = get()
    set(s => ({
      currentModel: model,
      conversations: s.conversations.map(c =>
        c.id === activeConversationId ? { ...c, model } : c
      ),
    }))
    if (activeConversationId) {
      await window.wos.updateConversation(activeConversationId, { model })
    }
  },

  setActiveConversationId: (id) => {
    set({ activeConversationId: id })
  },

  setConversationWorkspace: async (convId, workspaceId) => {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === convId ? { ...c, workspaceId } : c
      ),
    }))
    await window.wos.updateConversation(convId, { workspaceId })
  },

  renameConversation: async (convId, title) => {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === convId ? { ...c, title } : c
      ),
    }))
    await window.wos.updateConversation(convId, { title })
  },

  editMessage: async (messageId, newText) => {
    const { activeConversationId } = get()
    if (!activeConversationId) return

    const r = await window.wos.editMessage(messageId, newText) as {
      success: boolean
      error?: string
      code?: string
      failingId?: string
      newMessageId?: string
      branchGroupId?: string
      branchIndex?: number
    }
    if (!r.success) {
      // The most common cause of NOT_FOUND is a stale message id: the editor
      // submitted before a reload completed (e.g. the user spammed edit while
      // the agent was still streaming). Reload the conversation once and bail
      // — the editor will re-target the fresh row on the next click.
      if (r.code === 'NOT_FOUND') {
        await get().loadConversation(activeConversationId)
        toast.error('That message has moved — refreshed the view, please try again.')
        return
      }
      toast.error(`Edit failed: ${r.error}`)
      return
    }

    // Reload conversation to get updated messages with branch info, AND set the
    // active branch BEFORE kicking off continueConversation — otherwise the
    // continue handler may pick the wrong branch tail.
    await get().loadConversation(activeConversationId)

    if (r.branchGroupId && r.branchIndex !== undefined) {
      set(s => ({ activeBranches: { ...s.activeBranches, [r.branchGroupId!]: r.branchIndex! } }))
    }

    // Trigger agent response from the pre-saved edited user message
    void get().continueConversation()
  },

  switchBranch: (branchGroupId, newIndex) => {
    set(s => ({ activeBranches: { ...s.activeBranches, [branchGroupId]: newIndex } }))
  },
}))

// Expose store to window for debugging (always in dev, gated in prod)
if (typeof window !== 'undefined') {
  (window as unknown as { __wosStore__: typeof useAgentStore }).__wosStore__ = useAgentStore
}
