import { ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import { agentRunner } from '../agent/runner'
import { getDb, schema, notifyWrite } from '../db'
import { eq, asc, desc } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { cancelSubagent } from '../tools/subAgent'
import { resolveAgent } from '../agent/settings'

// ─── /subagents slash command handling ───────────────────────────────────────

function sendToSender(
  sender: Electron.WebContents,
  events: import('../agent/query').AgentEvent[],
) {
  for (const e of events) {
    if (!sender.isDestroyed()) sender.send('agent:event', e)
  }
}

async function handleSubagentsCommand(
  conversationId: string,
  rawCommand: string,
  sender: Electron.WebContents,
): Promise<boolean> {
  const trimmed = rawCommand.trim()
  if (!trimmed.startsWith('/subagents')) return false

  const rest = trimmed.replace(/^\/subagents\s*/, '').trim()
  const [sub, ...argParts] = rest.split(/\s+/)
  const arg = argParts.join(' ').trim()

  const db = getDb()

  // focus/unfocus are pure UI-state commands — no chat persistence/echo so
  // they don't leave dangling cards in the conversation.
  const isQuiet = sub === 'focus' || sub === 'unfocus'

  const emit = (text: string) => {
    if (sender.isDestroyed()) return
    // Emit as a text_delta so the UI renders it in the message stream.
    sender.send('agent:event', { type: 'text_delta', content: text })
  }

  const endTurn = () => {
    if (!sender.isDestroyed())
      sender.send('agent:event', { type: 'turn_complete', usage: { inputTokens: 0, outputTokens: 0 }, reason: 'end_turn' })
  }

  // Save a user message stub so the conversation log shows the command.
  if (!isQuiet) {
    try {
      db.insert(schema.messages).values({
        id: randomUUID(),
        conversationId,
        role: 'user',
        blocks: JSON.stringify([{ type: 'text', content: rawCommand }]),
        createdAt: new Date(),
      }).run()
      notifyWrite()
    } catch { /* non-fatal */ }
  }

  switch (sub) {
    case 'list': {
      const rows = db
        .select()
        .from(schema.subagentRuns)
        .where(eq(schema.subagentRuns.conversationId, conversationId))
        .orderBy(desc(schema.subagentRuns.startedAt))
        .limit(20)
        .all()

      if (rows.length === 0) {
        emit('No subagent runs found for this conversation.\n')
      } else {
        emit('**Subagent runs** (most recent 20):\n\n')
        for (const r of rows) {
          const startStr = r.startedAt ? new Date(r.startedAt).toISOString() : '?'
          const durSec = r.startedAt && r.endedAt
            ? (((r.endedAt as unknown as Date).getTime?.() ?? Number(r.endedAt)) - ((r.startedAt as unknown as Date).getTime?.() ?? Number(r.startedAt))) / 1000
            : null
          const durStr = durSec !== null ? `${durSec.toFixed(1)}s` : 'running'
          emit(`- \`${r.id.slice(0, 8)}\` **${r.status}** | ${r.goal.slice(0, 60)} | ${startStr} | ${durStr}\n`)
        }
      }
      break
    }

    case 'kill': {
      if (!arg) {
        emit('Usage: /subagents kill <agentId>\n')
        break
      }
      const cancelled = cancelSubagent(arg)
      // Also mark as cancelled in DB regardless (handles case where run just finished).
      try {
        db.update(schema.subagentRuns)
          .set({ status: 'cancelled', endedAt: new Date() })
          .where(eq(schema.subagentRuns.id, arg))
          .run()
      } catch { /* non-fatal */ }
      emit(cancelled
        ? `Subagent \`${arg}\` signalled for cancellation.\n`
        : `Subagent \`${arg}\` not found in-flight (may have already finished).\n`)
      break
    }

    case 'log': {
      if (!arg) {
        emit('Usage: /subagents log <agentId>\n')
        break
      }
      const row = db
        .select()
        .from(schema.subagentRuns)
        .where(eq(schema.subagentRuns.id, arg))
        .get()
      if (!row) {
        emit(`Subagent run \`${arg}\` not found.\n`)
        break
      }
      emit(`**Subagent log** for \`${arg}\`\n`)
      emit(`Goal: ${row.goal}\n`)
      emit(`Status: ${row.status}\n`)
      if (row.startedAt) emit(`Started: ${new Date(row.startedAt).toISOString()}\n`)
      if (row.endedAt) emit(`Ended: ${new Date(row.endedAt).toISOString()}\n`)
      if (row.summary) emit(`\n**Summary:**\n${row.summary}\n`)
      break
    }

    case 'focus': {
      if (!arg) {
        emit('Usage: /subagents focus <agentId>\n')
        break
      }
      if (!sender.isDestroyed())
        sender.send('agent:event', { type: 'subagent_focus', agentId: arg })
      // No emit() — focus is a pure UI command; the side panel reflects state.
      break
    }

    case 'unfocus': {
      if (!sender.isDestroyed())
        sender.send('agent:event', { type: 'subagent_focus', agentId: null })
      // No emit() — unfocus is a pure UI command; the side panel closes.
      break
    }

    default: {
      emit('**Usage:** `/subagents list | kill <id> | log <id> | focus <id> | unfocus`\n')
      break
    }
  }

  // Persist assistant response as a message.
  if (!isQuiet) {
    try {
      db.insert(schema.messages).values({
        id: randomUUID(),
        conversationId,
        role: 'assistant',
        blocks: JSON.stringify([{ type: 'text', content: `[/subagents ${sub ?? ''}]` }]),
        createdAt: new Date(),
      }).run()
      notifyWrite()
    } catch { /* non-fatal */ }
  }

  endTurn()
  return true
}

export function registerAgentHandlers(_win: BrowserWindow) {
  ipcMain.handle(
    'agent:send',
    async (
      event,
      {
        conversationId,
        message,
        attachments = [],
      }: {
        conversationId: string
        message: string
        attachments?: Array<{ name: string; content: string }>
      }
    ) => {
      try {
        // Intercept /subagents slash commands before forwarding to the agent.
        if (message.trim().startsWith('/subagents')) {
          const handled = await handleSubagentsCommand(conversationId, message, event.sender)
          if (handled) return { success: true }
        }

        await agentRunner.run(conversationId, message, attachments, event.sender)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Also surface an error event to the UI so the streaming spinner is
        // cleared and a visible error block appears in the current chat.
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent:event', { type: 'error', message: msg, retryable: false })
          event.sender.send('agent:event', { type: 'turn_complete', usage: { inputTokens: 0, outputTokens: 0 } })
        }
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle('agent:cancel', () => {
    agentRunner.cancel()
    return { success: true }
  })

  ipcMain.handle(
    'agent:continue',
    async (event, { conversationId }: { conversationId: string }) => {
      try {
        await agentRunner.continue(conversationId, event.sender)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent:event', { type: 'error', message: msg, retryable: false })
          event.sender.send('agent:event', { type: 'turn_complete', usage: { inputTokens: 0, outputTokens: 0 } })
        }
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    'agent:answer',
    (_event, { questionId, answer }: { questionId: string; answer: string }) => {
      agentRunner.resolveAnswer(questionId, answer)
      return { success: true }
    }
  )

  ipcMain.handle(
    'agent:permission',
    (
      _event,
      {
        toolId,
        decision,
      }: { toolId: string; decision: 'allow' | 'allow-session' | 'deny' }
    ) => {
      agentRunner.resolveAnswer(toolId, decision)
      return { success: true }
    }
  )

  ipcMain.handle(
    'agent:create-conversation',
    async (_event, { workspaceId, model, mode }: { workspaceId?: string; model?: string; mode?: string }) => {
      const db = getDb()

      // Default mode still comes from settings; default model now comes from
      // the WOS agent config (no global "default model" any more).
      const modeSetting = db.select().from(schema.settings).where(eq(schema.settings.key, 'defaultMode')).get()
      const defaultMode = (modeSetting?.value as string)?.replace(/^"|"$/g, '') ?? 'default'

      // Store only an explicitly passed model. If none is given, leave it empty
      // so the runner resolves the current WOS agent model on first use rather
      // than pinning whichever model happened to be active at creation time.
      const resolvedModel = model ?? ''

      const id = randomUUID()
      const now = new Date()
      db.insert(schema.conversations).values({
        id,
        title: 'New Conversation',
        workspaceId: workspaceId ?? null,
        model: resolvedModel,
        mode: mode ?? defaultMode,
        createdAt: now,
        updatedAt: now,
      }).run()
      notifyWrite()

      return {
        id,
        title: 'New Conversation',
        workspaceId: workspaceId ?? null,
        model: resolvedModel,
        mode: mode ?? defaultMode,
        createdAt: now,
        updatedAt: now,
        tokenCount: 0,
        contextLimit: 200000,
        isCompacted: false,
      }
    }
  )

  ipcMain.handle(
    'agent:update-conversation',
    async (_event, { conversationId, updates }: { conversationId: string; updates: Record<string, unknown> }) => {
      // Allowlist the updatable fields. The renderer is technically same-origin,
      // but defensive coding here prevents a renderer bug or rendered-content
      // injection from rewriting primary keys, workspace bindings, etc.
      const safe: Partial<typeof schema.conversations.$inferInsert> = { updatedAt: new Date() }
      if (typeof updates.title === 'string') safe.title = updates.title
      if (typeof updates.model === 'string') safe.model = updates.model
      if (updates.mode === 'default' || updates.mode === 'plan' || updates.mode === 'yolo') safe.mode = updates.mode
      if (typeof updates.workspaceId === 'string' || updates.workspaceId === null) {
        safe.workspaceId = updates.workspaceId as string | null
      }
      if (typeof updates.isCompacted === 'boolean') safe.isCompacted = updates.isCompacted
      if (typeof updates.tokenCount === 'number') safe.tokenCount = updates.tokenCount
      if (typeof updates.contextLimit === 'number') safe.contextLimit = updates.contextLimit
      const db = getDb()
      db.update(schema.conversations)
        .set(safe)
        .where(eq(schema.conversations.id, conversationId))
        .run()
      notifyWrite()
      return { success: true }
    }
  )

  // Export a conversation to Markdown via a save dialog.
  ipcMain.handle(
    'agent:export-conversation',
    async (_event, { conversationId }: { conversationId: string }) => {
      const db = getDb()
      const conv = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversationId))
        .get()
      if (!conv) return { ok: false, error: 'Conversation not found' }
      const messages = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(asc(schema.messages.createdAt))
        .all()

      const lines: string[] = []
      lines.push(`# ${conv.title || 'Conversation'}`)
      lines.push('')
      lines.push(`_Exported ${new Date().toISOString()} • model: ${conv.model || 'unknown'} • mode: ${conv.mode || 'default'}_`)
      lines.push('')
      for (const m of messages) {
        const role = m.role === 'user' ? '👤 User' : m.role === 'assistant' ? '🤖 Assistant' : `🔧 ${m.role}`
        lines.push(`## ${role}`)
        lines.push('')
        let body = ''
        const blocks = m.blocks
        if (typeof blocks === 'string') {
          body = blocks
        } else if (Array.isArray(blocks)) {
          for (const block of blocks as Array<Record<string, unknown>>) {
            if (block.type === 'text') body += String(block.content ?? '') + '\n'
            else if (block.type === 'reasoning') body += `_(reasoning)_\n${String(block.content ?? '')}\n`
            else if (block.type === 'tool_use') body += `\n\`tool: ${String(block.toolName ?? '')}\`\n`
            else if (block.type === 'ask_user') body += `\n> ❓ ${String(block.question ?? '')}\n`
          }
        }
        lines.push(body.trim())
        lines.push('')
      }

      const chosen = await dialog.showSaveDialog({
        defaultPath: `${(conv.title || 'conversation').replace(/[^a-z0-9-]+/gi, '-')}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
      fs.writeFileSync(chosen.filePath, lines.join('\n'), 'utf-8')
      return { ok: true, path: chosen.filePath }
    }
  )
}
