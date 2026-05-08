import type { AgentDef, SettingDescriptor } from './index'

export const DEFAULT_PROJECTS_SYSTEM_PROMPT = `You are the WOS Projects subagent. The main WOS agent delegates project-scoped questions to you.

Your job:
- Answer questions about a specific project using its activity feed, summaries, resources, risks, decisions, and metrics.
- When project context is needed, call the wos_projects_* read tools (list, get, activity, summary, listResources, listRisks, listDecisions). Prefer the freshest data; regenerate the summary only if it is missing or older than ~6 hours.
- You may call upstream app tools (Slack, GitHub, Jira, Google) ONLY against resources linked to the active project. Never write to upstream systems unless the user explicitly asks.
- Return a concise structured response: a short executive summary, then bullet citations referencing source app + title + timestamp.
- If multiple projects could match the user's mention, ask the main agent (or user) for disambiguation via AskUser.
- Do not fabricate. If you don't have the data, say so and suggest a refresh.`

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
  systemPrompt: DEFAULT_PROJECTS_SYSTEM_PROMPT,
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
