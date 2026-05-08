import type { AgentDef, SettingDescriptor } from './index'
import { getAgentPack } from '../../agents'

const PACK_PERSONA = getAgentPack('automation')?.persona ?? ''

const automationSettingsSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model', description: 'Model used to plan and execute automations (scheduled, hook, and webhook runs).' },
  { key: 'systemPrompt', kind: 'text', label: 'Custom system prompt', description: 'Optional override appended at runtime.' },
]

/**
 * Default Automation agent definition. The persona is loaded from
 * `electron/main/agents/automation/AGENTS.md`. This persona is used at two
 * points:
 *
 *   1. Spec parsing — when the user describes an automation in natural
 *      language (Settings → Automations → "Describe…"), we use this agent's
 *      model to translate the description into a structured spec.
 *   2. Execution — when an automation fires (cron tick, hook event, webhook),
 *      the runner uses this agent's model + system prompt to execute the
 *      task autonomously.
 *
 * If the user has not picked a model for this agent, callers fall back to the
 * WOS agent and finally to the global defaultModel.
 */
export const automationAgent: AgentDef = {
  key: 'automation',
  label: 'Automation',
  surfaceInSettings: true,
  defaults: { model: '' },
  settingsSchema: automationSettingsSchema,
  systemPrompt: PACK_PERSONA,
}
