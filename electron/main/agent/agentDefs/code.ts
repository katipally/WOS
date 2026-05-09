import type { AgentDef, SettingDescriptor } from './index'
import { getAgentPack } from '../../agents'

const PACK_PERSONA = getAgentPack('code')?.persona ?? ''

const codeSettingsSchema: SettingDescriptor[] = [
  {
    key: 'model',
    kind: 'model',
    label: 'Model',
    description: 'Model used by the coding agent. Inherits from WOS if unset.',
  },
  {
    key: 'reasoningEffort',
    kind: 'enum',
    label: 'Reasoning effort',
    description: 'How hard the model thinks before writing code. "high" catches edge cases and writes fewer bugs.',
    defaultValue: 'high',
    options: [
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ],
  },
]

export const codeAgent: AgentDef = {
  key: 'code',
  label: 'Coding',
  surfaceInSettings: true,
  systemPrompt: PACK_PERSONA,
  defaults: {
    model: '',
    reasoningEffort: 'high',
  },
  settingsSchema: codeSettingsSchema,
  // Untagged BUILTIN_TOOLS (Read, Write, Edit, Bash, Glob, Grep, WebSearch,
  // WebFetch, Task, AskUser, TodoWrite, EnterPlanMode, ExitPlanMode,
  // readSkillTool, readAppSkillTool, readRuleTool) always pass the tag filter.
  // GitHub app tools ('apps:github') are included.
  // delegate_to_coder is tagged 'orchestration' → excluded, preventing
  // recursive self-delegation.
  acceptedTags: ['apps:github'],
}
