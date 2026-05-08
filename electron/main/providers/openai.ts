import OpenAI from 'openai'
import type {
  ModelProvider, ModelRequest, StreamEvent, ModelInfo, TokenUsage
} from './types'
import { getDecryptedApiKeyForInstance } from './keystore'
import { enrichModel, modelSupportsReasoning } from './capabilities'

function mapReasoningEffort(effort?: string): 'low' | 'medium' | 'high' {
  const map: Record<string, 'low' | 'medium' | 'high'> = {
    low: 'low', medium: 'medium', high: 'high', max: 'high',
  }
  return map[effort ?? 'medium'] ?? 'medium'
}

type ResponsesInputItem =
  | OpenAI.Responses.EasyInputMessage
  | OpenAI.Responses.ResponseInputItem

function formatMessages(messages: ModelRequest['messages']): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = m.content as Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
    }>
    // Collect any text portions first
    const textParts: string[] = []
    const trailingItems: ResponsesInputItem[] = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        textParts.push(b.text)
      } else if (b.type === 'tool_use') {
        trailingItems.push({
          type: 'function_call',
          call_id: b.id ?? '',
          name: b.name ?? '',
          arguments: JSON.stringify(b.input ?? {}),
        } as OpenAI.Responses.ResponseInputItem)
      } else if (b.type === 'tool_result') {
        const raw = b.content
        const out_s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
        trailingItems.push({
          type: 'function_call_output',
          call_id: b.tool_use_id ?? '',
          output: out_s,
        } as OpenAI.Responses.ResponseInputItem)
      }
    }
    if (textParts.length) out.push({ role: m.role, content: textParts.join('') })
    out.push(...trailingItems)
  }
  return out
}

function formatTools(tools: ModelRequest['tools']): OpenAI.Responses.Tool[] {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false,
  }))
}

export interface OpenAIProviderOptions {
  /** Provider instance id used for keystore lookup. Defaults to 'openai'
   * (the legacy built-in instance) when omitted. */
  providerId?: string
  /** Override base URL for OpenAI-compatible endpoints. */
  baseURL?: string
  /** Extra headers (e.g. for routing/version pinning on compatible providers). */
  customHeaders?: Record<string, string>
}

export class OpenAIProvider implements ModelProvider {
  protected readonly providerId: string
  protected readonly baseURL?: string
  protected readonly customHeaders?: Record<string, string>

  constructor(opts: OpenAIProviderOptions = {}) {
    this.providerId = opts.providerId ?? 'openai'
    this.baseURL = opts.baseURL
    this.customHeaders = opts.customHeaders
  }

  protected buildClient(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.customHeaders ? { defaultHeaders: this.customHeaders } : {}),
    })
  }

  async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const apiKey = request.apiKeyOverride ?? await getDecryptedApiKeyForInstance(request.providerId ?? this.providerId)
    const client = this.buildClient(apiKey)
    const reasoningEffort = mapReasoningEffort(request.reasoningEffort)

    // Build input — prepend system as first user message if needed
    const input = formatMessages(request.messages)

    const toolCallInputs: Record<string, string> = {}
    const toolCallNames: Record<string, string> = {}
    const toolCallIds: Record<string, string> = {}

    let inputTokens = 0
    let outputTokens = 0

    try {
      const supportsReasoning = modelSupportsReasoning(request.model)
      const stream = await client.responses.create({
        model: request.model,
        input,
        instructions: request.systemPrompt || undefined,
        tools: formatTools(request.tools),
        ...(supportsReasoning
          ? { reasoning: { effort: reasoningEffort, summary: 'auto' } }
          : {}),
        stream: true,
        max_output_tokens: request.maxTokens ?? 16384,
      }, { signal: request.signal })

      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'text_delta', content: event.delta }
            break

          case 'response.reasoning_summary_text.delta':
            yield { type: 'thinking_delta', content: event.delta }
            break

          case 'response.output_item.added':
            if (event.item.type === 'function_call') {
              const itemId = event.item.id ?? ''
              const callId = event.item.call_id ?? itemId
              const name = event.item.name ?? ''
              toolCallNames[itemId] = name
              toolCallInputs[itemId] = ''
              toolCallIds[itemId] = callId
              yield { type: 'tool_preparing', id: callId, name }
            }
            break

          case 'response.function_call_arguments.delta': {
            const itemId = event.item_id ?? ''
            toolCallInputs[itemId] = (toolCallInputs[itemId] ?? '') + event.delta
            const callId = toolCallIds[itemId] ?? itemId
            yield { type: 'tool_arg_delta', id: callId, delta: event.delta }
            break
          }

          case 'response.function_call_arguments.done': {
            const itemId = event.item_id ?? ''
            const callId = toolCallIds[itemId] ?? itemId
            let parsedInput: unknown = {}
            try {
              parsedInput = JSON.parse(event.arguments ?? '{}')
            } catch {
              parsedInput = {}
            }
            yield {
              type: 'tool_use_start',
              id: callId,
              name: toolCallNames[itemId] ?? 'unknown',
              input: parsedInput,
            }
            break
          }

          case 'response.completed':
            inputTokens = event.response.usage?.input_tokens ?? 0
            outputTokens = event.response.usage?.output_tokens ?? 0
            break
        }
      }

      // Determine stop reason based on whether we have tool calls
      const hasToolCalls = Object.keys(toolCallNames).length > 0
      yield {
        type: 'message_stop',
        stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
        usage: { inputTokens, outputTokens },
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      throw err
    }
  }

  async fetchModels(apiKey: string): Promise<ModelInfo[]> {
    const client = this.buildClient(apiKey)
    const models = await client.models.list()
    return models.data
      .filter(m =>
        (m.id.startsWith('gpt-') || m.id.startsWith('o') || m.id.startsWith('chatgpt')) &&
        // Exclude audio, realtime, image, embedding, moderation, tts, transcribe, search variants
        !/(audio|realtime|image|embed|moderation|tts|transcribe|search|whisper|dall-e)/i.test(m.id)
      )
      .sort((a, b) => b.created - a.created)
      .map(m => ({
        ...enrichModel({ id: m.id, name: m.id }),
        providerId: this.providerId,
        kind: 'openai' as const,
      }))
  }
}
