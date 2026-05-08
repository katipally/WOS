import type { AgentDef, SettingDescriptor } from './index'
import { getAgentPack } from '../../agents'

const PACK_PERSONA = getAgentPack('meeting')?.persona ?? ''

/**
 * Back-compat export. Source of truth is now
 * `electron/main/agents/meeting/AGENTS.md`. This re-export exists so legacy
 * call sites and tests keep compiling.
 */
export const DEFAULT_MEETING_SYSTEM_PROMPT = PACK_PERSONA

const meetingSettingsSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model', description: 'Model used by the meeting agent.' },
  {
    key: 'liveSource', kind: 'enum', label: 'Live transcript source', defaultValue: 'captions',
    options: [{ value: 'captions', label: 'Live captions' }],
  },
  { key: 'autoSummarize', kind: 'boolean', label: 'Auto-summarize after meeting ends', defaultValue: true },
  { key: 'defaultSlackChannel', kind: 'string', label: 'Default Slack channel for follow-ups', defaultValue: '' },
  { key: 'systemPrompt', kind: 'text', label: 'Custom system prompt' },
]

export const meetingAgent: AgentDef = {
  key: 'meeting',
  label: 'Meeting',
  surfaceInSettings: true,
  systemPrompt: PACK_PERSONA,
  defaults: {
    model: '',
    liveSource: 'captions',
    autoSummarize: true,
    defaultSlackChannel: '',
  },
  settingsSchema: meetingSettingsSchema,
  acceptedTags: ['meetings', 'apps:google', 'apps:slack'],
}
