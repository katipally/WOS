import { getProvider } from '../providers'
import { resolveAgent, resolveApiKeyForModel } from '../agent/settings'

// DEMO: force GPT-4.5 for meeting analysis regardless of agent settings
const MEETING_DEMO_MODEL = 'gpt-5.4'

export interface MeetingAnalysisResult {
  summary: string
  actionItems: Array<{ owner?: string | null; task: string; dueDate?: string | null }>
  decisions: Array<{ decision: string; context?: string | null }>
  openQuestions: string[]
  topics?: string[]
  qa?: Array<{ question: string; answer?: string }>
}

/**
 * Tool schema we force the model to call exactly once. Routing the structured
 * output through a tool call (rather than asking for raw JSON in the text
 * stream) gives us guaranteed-parseable input on BOTH OpenAI and Anthropic —
 * no truncation, no markdown fences, no "Unterminated string" 400s.
 */
const SAVE_NOTES_TOOL = {
  name: 'save_meeting_notes',
  description: 'Persist the structured meeting notes back to the host application. Call this exactly once with the full result.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description: '2-3 paragraph summary of the meeting in plain prose.',
      },
      actionItems: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task: { type: 'string', description: 'Action item, written as an imperative sentence.' },
            owner: { type: ['string', 'null'], description: 'Person responsible if mentioned, otherwise null.' },
            dueDate: { type: ['string', 'null'], description: 'Due date if mentioned, otherwise null.' },
          },
          required: ['task'],
        },
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decision: { type: 'string', description: 'What was decided.' },
            context: { type: ['string', 'null'], description: 'Why or background. May be null.' },
          },
          required: ['decision'],
        },
      },
      openQuestions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Unresolved questions raised in the meeting.',
      },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short topic labels covered, ordered as discussed.',
      },
      qa: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string' },
            answer: { type: ['string', 'null'] },
          },
          required: ['question'],
        },
      },
    },
    required: ['summary', 'actionItems', 'decisions', 'openQuestions'],
  },
}

export const SAVE_NOTES_TOOL_FOR_TESTS = SAVE_NOTES_TOOL

export function clampTranscript(transcript: string, maxChars = 120_000): string {
  if (transcript.length <= maxChars) return transcript
  // Keep the head and the tail — meetings usually open with intros and close
  // with action items/decisions; the middle is the most expendable.
  const head = transcript.slice(0, Math.floor(maxChars * 0.7))
  const tail = transcript.slice(-Math.floor(maxChars * 0.3))
  return `${head}\n\n[... transcript truncated ${transcript.length - maxChars} chars ...]\n\n${tail}`
}

export function asResult(input: unknown): MeetingAnalysisResult {
  const v = (input ?? {}) as Partial<MeetingAnalysisResult>
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    actionItems: Array.isArray(v.actionItems) ? v.actionItems : [],
    decisions: Array.isArray(v.decisions) ? v.decisions : [],
    openQuestions: Array.isArray(v.openQuestions) ? v.openQuestions : [],
    topics: Array.isArray(v.topics) ? v.topics : [],
    qa: Array.isArray(v.qa) ? v.qa : [],
  }
}

export async function analyzeTranscript(transcript: string, title?: string, signal?: AbortSignal): Promise<MeetingAnalysisResult> {
  if (!transcript || !transcript.trim()) {
    throw new Error('Cannot analyze an empty transcript.')
  }

  const meetingAnalyzeSettings = await resolveAgent('meetingsAnalyze').catch(() => null)
  const fallback = await resolveAgent('meeting')
  const resolved = meetingAnalyzeSettings && meetingAnalyzeSettings.model ? meetingAnalyzeSettings : fallback

  // DEMO: force GPT-4.5 — swap MEETING_DEMO_MODEL above to change
  const demoApiKey = await resolveApiKeyForModel(MEETING_DEMO_MODEL)
  const agent = {
    ...resolved,
    model: MEETING_DEMO_MODEL,
    apiKeyOverride: demoApiKey ?? resolved.apiKeyOverride,
  }

  const systemPrompt = `${agent.systemPrompt || fallback.systemPrompt || ''}

You will receive a meeting transcript. Extract the structured notes by calling the \`save_meeting_notes\` tool exactly once with the requested schema. Do not respond with any text outside of that tool call. Be faithful to the transcript — never invent owners, dates, or decisions that are not grounded in it.`

  const userPrompt = `Meeting title: ${title ?? 'Untitled Meeting'}

Transcript:
${clampTranscript(transcript)}`

  const provider = getProvider(agent.model)

  let toolInput: unknown = null
  let textBuffer = ''
  let stopReason = ''

  for await (const event of provider.stream({
    model: agent.model,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [SAVE_NOTES_TOOL],
    systemPrompt,
    apiKeyOverride: agent.apiKeyOverride,
    // Generous budget: a typical meeting summary fits in ~2k tokens, but we
    // pad heavily so we never run out mid-JSON. Reasoning models also need
    // headroom for the hidden chain-of-thought.
    maxTokens: 16_384,
    signal,
  })) {
    if (event.type === 'tool_use_start' && event.name === SAVE_NOTES_TOOL.name) {
      toolInput = event.input
    } else if (event.type === 'text_delta') {
      textBuffer += event.content
    } else if (event.type === 'message_stop') {
      stopReason = event.stopReason
    }
  }

  if (toolInput) return asResult(toolInput)

  // Fallback: some models still emit JSON in the text stream instead of using
  // the tool. Try to recover; if we can't, surface a clear error rather than
  // a JSON.parse stack trace.
  if (textBuffer.trim()) {
    const match = textBuffer.match(/\{[\s\S]*\}/)
    if (match) {
      try { return asResult(JSON.parse(match[0])) } catch { /* fall through */ }
    }
  }

  if (stopReason === 'length') {
    throw new Error(
      'The model ran out of output tokens before finishing the analysis. Try a smaller transcript or pick a model with a larger output budget.'
    )
  }
  throw new Error('The model did not return structured meeting notes. Try again, or switch the Meeting Agent model in Settings.')
}
