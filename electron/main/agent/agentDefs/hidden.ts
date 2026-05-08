import type { AgentDef, SettingDescriptor } from './index'

/**
 * Hidden agents — never shown in Settings → Agents.
 *
 * These are internal helpers used by the runner and various subsystems
 * (intent classification, fact extraction, compaction, meeting analysis,
 * project intelligence). They share a minimal settings schema so they can
 * be configured programmatically (or via direct DB writes for power users)
 * but no UI surface is provided. Their model selection falls back to the
 * WOS agent and finally to the global defaultModel.
 */

const baseSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model' },
  { key: 'systemPrompt', kind: 'text', label: 'Custom system prompt', description: 'Optional override / addition.' },
]

function makeDef(opts: {
  key: string
  label: string
  description?: string
  defaultPrompt?: string
}): AgentDef {
  return {
    key: opts.key,
    label: opts.label,
    surfaceInSettings: false,
    systemPrompt: opts.defaultPrompt ?? '',
    defaults: { model: '' },
    settingsSchema: baseSchema,
  }
}

export const intentAgent = makeDef({
  key: 'intent',
  label: 'Intent classifier',
  defaultPrompt:
    'You classify the user\'s latest message into a small set of intent tags so that downstream tooling can be filtered. Respond with a compact JSON object — never prose.',
})

export const factExtractorAgent = makeDef({
  key: 'factExtractor',
  label: 'Memory fact extractor',
  defaultPrompt:
    'You read a conversation snippet and extract durable facts about the user (preferences, projects, recurring tools). Output JSON; ignore one-off chatter.',
})

export const compactionAgent = makeDef({
  key: 'compaction',
  label: 'Context compaction',
  defaultPrompt:
    'You compress earlier conversation turns into a brief, faithful summary that the main agent can use to continue without losing critical state.',
})

export const meetingsAnalyzeAgent = makeDef({
  key: 'meetingsAnalyze',
  label: 'Meeting analyzer',
  defaultPrompt:
    'You read a meeting transcript and produce a structured analysis: summary, action items, decisions, and noteworthy quotes — citing speaker and timestamps when available.',
})

export const projectsIntelligenceAgent = makeDef({
  key: 'projectsIntelligence',
  label: 'Project intelligence',
  defaultPrompt:
    'You produce a fresh project summary from raw activity (chat, code, docs). Highlight risks, decisions, blockers, and recent momentum.',
})

