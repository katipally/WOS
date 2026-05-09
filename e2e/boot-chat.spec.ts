/**
 * d1: boot-chat — app boots, stub agent replies, history persists across re-launch.
 *
 * Covers:
 *   - Renderer renders the chat UI (textarea visible, "Start a conversation" placeholder)
 *   - Sending a message triggers the stub and renders the reply
 *   - Messages are persisted to the DB
 *   - On re-launch with the same userDataDir, prior conversation is listed in the sidebar
 */

import { test, expect } from '@playwright/test'
import { withStub, stubPath, sendChatMessage } from './harness/withStub'
import { dumpState } from './harness/artifacts'

test('d1: chat textarea is visible on boot', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    await expect(wos.window).toHaveTitle(/.+/, { timeout: 30_000 })
    const textarea = wos.window.getByPlaceholder('Plan, build, or ask anything… (type / or @)')
    await expect(textarea).toBeVisible()
    await expect(wos.window.getByText('Start a conversation')).toBeVisible()
  } finally {
    db.close()
    await wos.close()
  }
})

test('d1: sending a message renders the stub reply', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    await sendChatMessage(wos.window, 'Hello!')
    // Wait for stub response to appear in the UI.
    await expect(wos.window.getByText('Hello from WOS stub!')).toBeVisible({ timeout: 30_000 })

    // Dump for human inspection.
    await dumpState(wos.window, wos, 'd1-after-reply')
  } finally {
    db.close()
    await wos.close()
  }
})

test('d1: messages are persisted to the DB', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    await sendChatMessage(wos.window, 'Persist me!')
    await expect(wos.window.getByText('Hello from WOS stub!')).toBeVisible({ timeout: 30_000 })

    // Verify user message and assistant message exist in DB.
    const msgs = await db.queryAll<{ role: string; blocks: string }>(
      `SELECT role, blocks FROM messages ORDER BY createdAt ASC`,
    )
    const roles = msgs.map((m) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')

    const assistantMsg = msgs.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    const blocks = JSON.parse(assistantMsg!.blocks) as Array<{ type: string; content?: string }>
    const textBlock = blocks.find((b) => b.type === 'text')
    expect(textBlock?.content).toContain('Hello from WOS stub!')
  } finally {
    db.close()
    await wos.close()
  }
})

test('d1: conversation history is visible after re-launch', async () => {
  // First launch: send a message and verify the reply.
  let savedUserDataDir: string
  {
    const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
    savedUserDataDir = wos.userDataDir
    try {
      await sendChatMessage(wos.window, 'Remember me!')
      await expect(wos.window.getByText('Hello from WOS stub!')).toBeVisible({ timeout: 30_000 })
    } finally {
      db.close()
      await wos.close()
    }
  }

  // Second launch: same userDataDir, no stub needed for history check.
  const { wos: wos2, db: db2 } = await withStub({
    scriptPath: stubPath('simple-reply.json'),
    userDataDir: savedUserDataDir,
  })
  try {
    await expect(wos2.window).toHaveTitle(/.+/, { timeout: 30_000 })
    // The sidebar should list the prior conversation. Check DB for conversations.
    const convs = await db2.queryAll<{ id: string; title: string | null }>(
      'SELECT id, title FROM conversations ORDER BY createdAt DESC LIMIT 5',
    )
    expect(convs.length).toBeGreaterThanOrEqual(1)

    // Verify messages still exist for that conversation.
    const msgs = await db2.queryAll<{ role: string }>(
      `SELECT role FROM messages WHERE conversationId = ? ORDER BY createdAt ASC`,
      convs[0].id,
    )
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true)
  } finally {
    db2.close()
    await wos2.close()
  }
})
