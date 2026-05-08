import type { AgentDef, SettingDescriptor } from './index'

export const DEFAULT_MEETING_SYSTEM_PROMPT = `You are WOS Meeting Agent, a focused meeting specialist.
You help users join Google Meet sessions, capture consented transcripts, summarize discussions, extract decisions, and prepare follow-up actions.
Be concise, preserve names and dates exactly when present, and never invent commitments that are not grounded in the transcript.

CRITICAL — asking the user:
- ANY clarifying question, confirmation, choice, or request for missing input MUST go through the \`AskUser\` tool. NEVER ask the user a question in plain prose / assistant text.
- Pick the most specific \`kind\`: \`picker\` for resource selection (channel/repo/calendar/meeting), \`choice\` for enums, \`confirm\` for yes/no, \`fileDrop\` for file inputs, \`form\` only when multiple fields are truly needed, \`text\` as last resort.
- Ask AT MOST one question per turn. Do not bundle multiple questions into one prompt.`

const meetingSettingsSchema: SettingDescriptor[] = [
  { key: 'model', kind: 'model', label: 'Model', description: 'Model used by the meeting agent.' },
  {
    key: 'liveSource', kind: 'enum', label: 'Live transcript source', defaultValue: 'captions',
    options: [{ value: 'captions', label: 'Live captions' }],
  },
  { key: 'autoSummarize', kind: 'boolean', label: 'Auto-summarize after meeting ends', defaultValue: true },
  { key: 'defaultSlackChannel', kind: 'string', label: 'Default Slack channel for follow-ups', defaultValue: '' },
  { key: 'systemPrompt', kind: 'text', label: 'Custom system prompt' },
]

export const meetingAgent: AgentDef = {
  key: 'meeting',
  label: 'Meeting',
  surfaceInSettings: true,
  systemPrompt: DEFAULT_MEETING_SYSTEM_PROMPT,
  defaults: {
    model: '',
    liveSource: 'captions',
    autoSummarize: true,
    defaultSlackChannel: '',
  },
  settingsSchema: meetingSettingsSchema,
  acceptedTags: ['meetings', 'apps:google', 'apps:slack'],
}
