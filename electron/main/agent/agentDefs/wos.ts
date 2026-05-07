import { WOS_AGENT_POLICY } from '../../training/orchestration/prompt.ts'
import type { AgentDef } from './index'

/**
 * Default WOS agent definition. Sees every tool the registry composed —
 * built-ins, skills/rules, meetings, app tools, MCP tools.
 *
 * The system prompt here adds a small smart-routing instruction so the
 * agent knows to delegate meeting-specific work to the meeting subagent.
 */
export const wosAgent: AgentDef = {
  key: 'wos',
  systemPrompt: WOS_AGENT_POLICY,
  toolFilter: (allTools) => allTools,
}
