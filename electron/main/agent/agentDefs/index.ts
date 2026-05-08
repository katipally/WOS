/**
 * Agent definitions registry.
 *
 * Each definition declares:
 *   - key: stable identifier ("wos", "meeting", ...)
 *   - label: human-readable name shown in Settings → Agents (defaults to key)
 *   - systemPrompt: replaces or augments the base prompt for this agent
 *   - defaults: starting configJson values when no DB row exists yet
 *   - settingsSchema: declarative form schema used by Settings → Agents to
 *     render per-agent toggles/picks. Each entry maps to a configJson field.
 *   - acceptedTags: tag set used by tool filtering. A tool with any matching
 *     `tags` (see `Tool.tags`) is exposed to this agent.
 *   - surfaceInSettings: when true, the agent appears in Settings → Agents
 *     so users can pick a model / tweak its config. Hidden agents (intent,
 *     factExtractor, …) are still configurable via the same IPCs.
 *   - toolFilter: legacy hook for agents that need custom logic beyond tags.
 *     Defaults to acceptedTags-based filtering when omitted.
 */

import type { Tool } from '../../tools'
import { getAgentPack } from '../../agents'
import { wosAgent } from './wos'
import { meetingAgent } from './meeting'
import { projectsAgent } from './projects'
import { automationAgent } from './automation'
import {
  intentAgent,
  factExtractorAgent,
  compactionAgent,
  meetingsAnalyzeAgent,
  projectsIntelligenceAgent,
} from './hidden'

export type SettingDescriptorKind =
  | 'string'
  | 'text'
  | 'boolean'
  | 'number'
  | 'enum'
  | 'model'

export interface SettingDescriptor {
  key: string
  kind: SettingDescriptorKind
  label: string
  description?: string
  defaultValue?: unknown
  /** For kind: 'enum' — the list of allowed values. */
  options?: Array<{ value: string; label: string }>
  /** For kind: 'number' — bounds. */
  min?: number
  max?: number
}

export interface AgentDef {
  key: string
  label?: string
  systemPrompt?: string
  /** Free-form starting config (merged under any DB row). */
  defaults?: Record<string, unknown>
  /** Declarative form schema for the Settings → Agents UI. */
  settingsSchema?: SettingDescriptor[]
  /** Tags this agent will accept from the tool registry. */
  acceptedTags?: string[]
  /** Whether this agent is shown in Settings → Agents. */
  surfaceInSettings?: boolean

  /** Optional explicit tool filter. When omitted, acceptedTags is used. */
  toolFilter?(allTools: Tool[]): Tool[]
}

/**
 * Apply an agent's tool filter. Order:
 *   1. If `def.toolFilter` is provided, use it.
 *   2. Else if `def.acceptedTags` is provided, keep tools whose `tags`
 *      intersect the accepted set (untagged tools are kept — they predate
 *      the tag system and are considered universal).
 *   3. Else expose every tool.
 */
export function filterToolsForAgent(def: AgentDef | undefined, allTools: Tool[]): Tool[] {
  if (!def) return allTools
  if (def.toolFilter) return def.toolFilter(allTools)
  if (def.acceptedTags && def.acceptedTags.length > 0) {
    const accepted = new Set(def.acceptedTags)
    return allTools.filter(t => {
      const tags = (t as { tags?: string[] }).tags
      if (!tags || tags.length === 0) return true
      return tags.some(tag => accepted.has(tag))
    })
  }
  return allTools
}

const defs: Record<string, AgentDef> = {
  [wosAgent.key]: wosAgent,
  [meetingAgent.key]: meetingAgent,
  [projectsAgent.key]: projectsAgent,
  [automationAgent.key]: automationAgent,
  [intentAgent.key]: intentAgent,
  [factExtractorAgent.key]: factExtractorAgent,
  [compactionAgent.key]: compactionAgent,
  [meetingsAnalyzeAgent.key]: meetingsAnalyzeAgent,
  [projectsIntelligenceAgent.key]: projectsIntelligenceAgent,
}

export function getAgentDef(key: string | undefined | null): AgentDef | undefined {
  if (!key) return undefined
  const def = defs[key]
  if (!def) return undefined
  // If a matching AgentPack ships an AGENTS.md, use its persona as the
  // system prompt source. This lets users edit personas in markdown
  // without touching TypeScript while keeping AgentDef as the runtime
  // contract for tags / settings / defaults.
  const pack = getAgentPack(key)
  if (pack && pack.persona) {
    return { ...def, systemPrompt: pack.persona }
  }
  return def
}

export function listAgentDefs(): AgentDef[] {
  return Object.values(defs)
}

export function listVisibleAgentDefs(): AgentDef[] {
  return listAgentDefs().filter(d => d.surfaceInSettings !== false)
}

export { wosAgent, meetingAgent, projectsAgent, automationAgent }
export {
  intentAgent,
  factExtractorAgent,
  compactionAgent,
  meetingsAnalyzeAgent,
  projectsIntelligenceAgent,
}
