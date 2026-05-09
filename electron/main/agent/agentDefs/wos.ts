import type { AgentDef, SettingDescriptor } from './index'
import { getAgentPack } from '../../agents'

const PACK_PERSONA = getAgentPack('wos')?.persona ?? ''

const wosSettingsSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model', description: 'Model used by the WOS agent.' },
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

/**
 * Default WOS agent definition. Sees every tool the registry composed —
 * built-ins, skills/rules, meetings, app tools, MCP tools.
 *
 * The persona/system prompt is loaded from
 * `electron/main/agents/wos/AGENTS.md` so users can edit it without
 * touching TypeScript.
 */
export const wosAgent: AgentDef = {
  key: 'wos',
  label: 'WOS',
  surfaceInSettings: true,
  defaults: {
    model: '',
    reasoningEffort: 'medium',
  },
  settingsSchema: wosSettingsSchema,
  systemPrompt: PACK_PERSONA,
  // No tag filter → wos sees every tool the registry composed.
  toolFilter: (allTools) => allTools,
}
