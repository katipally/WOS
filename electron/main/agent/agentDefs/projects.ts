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
  { key: 'autoSummarize', kind: 'boolean', label: 'Auto-summarize project activity', defaultValue: true },
  { key: 'summaryStaleHours', kind: 'number', label: 'Regenerate summary after (hours)', defaultValue: 6, min: 1, max: 168 },
  { key: 'systemPrompt', kind: 'text', label: 'Custom system prompt' },
]

export const projectsAgent: AgentDef = {
  key: 'projects',
  label: 'Projects',
  surfaceInSettings: true,
  systemPrompt: PACK_PERSONA,
  defaults: {
    model: '',
    autoSummarize: true,
    summaryStaleHours: 6,
  },
  settingsSchema: projectsSettingsSchema,
  acceptedTags: [
    'projects',
    'meetings',
    'apps:github', 'apps:gmail', 'apps:google', 'apps:slack', 'apps:jira',
    'apps:drive', 'apps:calendar',
  ],
}
