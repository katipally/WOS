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
    key: 'reasoningEffort', kind: 'enum', label: 'Reasoning effort',
    description: 'How much the model reasons before answering. Disabled when the selected model has no reasoning support.',
    defaultValue: 'medium',
    options: [
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ],
  },
]

export const meetingAgent: AgentDef = {
  key: 'meeting',
  label: 'Meeting',
  surfaceInSettings: true,
  systemPrompt: PACK_PERSONA,
  defaults: {
    model: '',
    reasoningEffort: 'medium',
  },
  settingsSchema: meetingSettingsSchema,
  acceptedTags: ['meetings', 'apps:google', 'apps:slack'],
}
