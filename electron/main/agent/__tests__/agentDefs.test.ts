import { describe, expect, it } from 'vitest'
import { getAgentDef, filterToolsForAgent } from '../agentDefs'
import type { Tool } from '../../tools'

const fakeTool = (name: string, tags?: string[]): Tool => ({
  name,
  description: `tool ${name}`,
  inputSchema: { type: 'object' },
  execute: async () => ({ output: '' }),
  ...(tags ? { tags } : {}),
} as Tool)

describe('agentDefs', () => {
  it('wos agent passes through every tool', () => {
    const def = getAgentDef('wos')!
    const all = ['fileRead', 'bash', 'meeting_list', 'slack_post', 'github_pr'].map(n => fakeTool(n))
    expect(filterToolsForAgent(def, all).map(t => t.name)).toEqual(all.map(t => t.name))
  })

  it('meeting agent curates tagged tools (only meetings/google/slack apps)', () => {
    const def = getAgentDef('meeting')!
    const all = [
      fakeTool('fileRead'), fakeTool('fileWrite'), fakeTool('webFetch'),
      fakeTool('meeting_list', ['meetings']), fakeTool('meeting_search', ['meetings']),
      fakeTool('meeting_summarize', ['meetings']),
      fakeTool('google_calendar_list', ['apps:google', 'apps']),
      fakeTool('slack_send', ['apps:slack', 'apps']),
      fakeTool('github_create_issue', ['apps:github', 'apps']),
      fakeTool('mcp_random', ['mcp']),
      fakeTool('AskUser'), fakeTool('read_skill'), fakeTool('read_rule'),
    ]
    const got = filterToolsForAgent(def, all).map(t => t.name).sort()
    expect(got).toContain('meeting_list')
    expect(got).toContain('webFetch')
    expect(got).toContain('AskUser')
    expect(got).toContain('google_calendar_list')
    expect(got).toContain('slack_send')
    expect(got).not.toContain('github_create_issue')
    expect(got).not.toContain('mcp_random')
  })

  it('returns undefined for unknown agent keys', () => {
    expect(getAgentDef('does-not-exist')).toBeUndefined()
    expect(getAgentDef(null)).toBeUndefined()
  })

  it('meeting agent exposes the full meeting tool superset', () => {
    const def = getAgentDef('meeting')!
    const all = [
      ...['meeting_list', 'meeting_search', 'meeting_get', 'meeting_summarize',
        'meeting_extract_actions', 'meeting_rename', 'meeting_delete'].map(n => fakeTool(n, ['meetings'])),
      fakeTool('fileRead'), fakeTool('fileWrite'), fakeTool('bash'),
    ]
    const got = filterToolsForAgent(def, all).map(t => t.name)
    for (const name of [
      'meeting_list', 'meeting_search', 'meeting_get', 'meeting_summarize',
      'meeting_extract_actions', 'meeting_rename', 'meeting_delete',
    ]) {
      expect(got, `meeting agent should expose ${name}`).toContain(name)
    }
  })

  it('wos agent system prompt advertises Task delegation for meeting work', () => {
    const def = getAgentDef('wos')!
    expect(def.systemPrompt ?? '').toMatch(/meeting subagent|preset.*meeting/i)
    expect(def.systemPrompt ?? '').toMatch(/Task tool/)
  })
})
