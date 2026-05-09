import type { AgentDef, SettingDescriptor } from './index'
import { getAgentPack } from '../../agents'

const PACK_PERSONA = getAgentPack('projects')?.persona ?? ''

/**
 * Back-compat re-export. Source of truth is now
 * `electron/main/agents/projects/AGENTS.md`.
 */
export const DEFAULT_PROJECTS_SYSTEM_PROMPT = PACK_PERSONA

const projectsSettingsSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model', description: 'Model used by the projects agent.' },
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

export const projectsAgent: AgentDef = {
  key: 'projects',
  label: 'Projects',
  surfaceInSettings: true,
  systemPrompt: PACK_PERSONA,
  defaults: {
    model: '',
    reasoningEffort: 'medium',
  },
  settingsSchema: projectsSettingsSchema,
  acceptedTags: [
    'projects',
    'meetings',
    'apps:github', 'apps:gmail', 'apps:google', 'apps:slack', 'apps:jira',
    'apps:drive', 'apps:calendar',
  ],
}
