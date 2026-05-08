import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { initDatabase, getDb, schema } from '../../db'
import { resolveAgent, DEFAULT_MEETING_SYSTEM_PROMPT } from '../settings'

const userData = (app as unknown as { getPath: (name: string) => string }).getPath('userData')

beforeAll(async () => {
  fs.mkdirSync(userData, { recursive: true })
  const dbPath = path.join(userData, 'wos.db')
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath)
  await initDatabase()
})

afterAll(() => {
  const dbPath = path.join(userData, 'wos.db')
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath)
})

describe('resolveAgent', () => {
  it('returns the meeting agent with seeded defaults', async () => {
    const agent = await resolveAgent('meeting')
    expect(agent.agentKey).toBe('meeting')
    expect(agent.config.liveSource).toBe('captions')
    expect(agent.config.autoSummarize).toBe(true)
    expect(agent.systemPrompt).toBe(DEFAULT_MEETING_SYSTEM_PROMPT)
  })

  it('uses the model stored on the agent row, with no cross-agent inheritance', async () => {
    const db = getDb()
    const now = new Date()
    db.insert(schema.agentSettings)
      .values({
        agentKey: 'wos',
        model: 'gpt-4o-mini',
        mode: null,
        systemPrompt: null,
        configJson: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.agentSettings.agentKey,
        set: { model: 'gpt-4o-mini', updatedAt: now },
      })
      .run()
    const wos = await resolveAgent('wos')
    expect(wos.model).toBe('gpt-4o-mini')
    // meeting agent has no row override → resolves to its own (empty) default,
    // not the wos row's model.
    const meeting = await resolveAgent('meeting')
    expect(meeting.model).not.toBe('gpt-4o-mini')
  })
})
