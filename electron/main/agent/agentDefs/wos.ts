import type { AgentDef, SettingDescriptor } from './index'
import { getAgentPack } from '../../agents'

const PACK_PERSONA = getAgentPack('wos')?.persona ?? ''

const wosSettingsSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model', description: 'Model used by the WOS agent.' },
  {
    key: 'mode', kind: 'enum', label: 'Mode', description: 'Default response mode.', defaultValue: 'default',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan first' },
      { value: 'concise', label: 'Concise' },
    ],
  },
  { key: 'systemPrompt', kind: 'text', label: 'Custom system prompt', description: 'Optional override appended at runtime.' },
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
    mode: 'default',
  },
  settingsSchema: wosSettingsSchema,
  systemPrompt: PACK_PERSONA,
  // No tag filter → wos sees every tool the registry composed.
  toolFilter: (allTools) => allTools,
}
