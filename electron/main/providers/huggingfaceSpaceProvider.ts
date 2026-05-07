import OpenAI from 'openai'
import type {
  ModelProvider, ModelRequest, StreamEvent, ModelInfo, TokenUsage,
} from './types'
import { getDecryptedApiKeyOrNull } from './keystore'
import { enrichModel, modelSupportsReasoning } from './capabilities'
import {
  decodeHuggingFaceSpaceModelId,
  getHuggingFaceSpace,
} from './huggingfaceSpaces'

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
      thinking?: string
    }>
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
        const output = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
        trailingItems.push({
          type: 'function_call_output',
          call_id: b.tool_use_id ?? '',
          output,
        } as OpenAI.Responses.ResponseInputItem)
      }
    }
    if (textParts.length) out.push({ role: m.role, content: textParts.join('') })
    out.push(...trailingItems)
  }
  return out
}

function formatResponsesTools(tools: ModelRequest['tools']): OpenAI.Responses.Tool[] {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false,
  }))
}

function formatChatTools(tools: ModelRequest['tools']): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }))
}

/** Build Chat Completions messages from WOS conversation turns (tool_use / tool_result blocks). */
function buildChatCompletionMessages(request: ModelRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  const sys = request.systemPrompt?.trim()
  if (sys) out.push({ role: 'system', content: sys })

  for (const m of request.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = m.content

    if (m.role === 'user') {
      const textParts: string[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text) textParts.push(b.text)
        if (b.type === 'tool_result') {
          if (textParts.length) {
            out.push({ role: 'user', content: textParts.join('\n') })
            textParts.length = 0
          }
          const raw = b.content
          const content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id ?? '',
            content,
          })
        }
      }
      if (textParts.length) out.push({ role: 'user', content: textParts.join('\n') })
      continue
    }

    let text = ''
    const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) text += b.text
      if (b.type === 'thinking' && b.thinking) text += b.thinking
      if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id ?? '',
          type: 'function',
          function: {
            name: b.name ?? '',
            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
          },
        })
      }
    }

    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: text.trim() ? text : (toolCalls.length ? null : ''),
    }
    if (toolCalls.length) assistant.tool_calls = toolCalls
    out.push(assistant)
  }

  return out
}

function responsesEndpointLikelyUnsupported(err: unknown): boolean {
  const e = err as { status?: number; message?: string; code?: string }
  const s = e?.status
  if (s === 404 || s === 405 || s === 501) return true
  const msg = `${e?.message ?? ''} ${e?.code ?? ''}`
  if (/responses/i.test(msg) && /404|not\s+found|unknown\s+path|unsupported/i.test(msg)) return true
  return false
}

function createClient(baseURL: string, apiKey?: string): OpenAI {
  return new OpenAI({
    apiKey: apiKey ?? 'hf-space',
    baseURL,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers ?? undefined)
      if (!apiKey) headers.delete('Authorization')
      return fetch(input, { ...init, headers })
    },
  })
}

function asUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return { inputTokens, outputTokens }
}

async function* streamResponsesApi(
  client: OpenAI,
  request: ModelRequest,
  decodedModelId: string,
): AsyncGenerator<StreamEvent> {
  // vLLM (and many OpenAI-compatible servers) enforce a hard max total context length.
  // Our app-level defaults use 16k as a generic budget; clamp for HF Spaces to avoid 400s.
  const maxTotalTokens = 8192
  // Also cap output so we don't accidentally request the full context as output.
  const maxOutputTokens = Math.min(request.maxTokens ?? 512, 2048, maxTotalTokens)
  const input = formatMessages(request.messages)
  const reasoningEffort = mapReasoningEffort(request.reasoningEffort)
  const toolCallInputs: Record<string, string> = {}
  const toolCallNames: Record<string, string> = {}
  const toolCallIds: Record<string, string> = {}

  let inputTokens = 0
  let outputTokens = 0

  const supportsReasoning = modelSupportsReasoning(decodedModelId)
  const stream = await client.responses.create({
    model: decodedModelId,
    input,
    instructions: request.systemPrompt || undefined,
    tools: formatResponsesTools(request.tools),
    ...(supportsReasoning
      ? { reasoning: { effort: reasoningEffort, summary: 'auto' } }
      : {}),
    stream: true,
    max_output_tokens: maxOutputTokens,
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

  const hasToolCalls = Object.keys(toolCallNames).length > 0
  yield {
    type: 'message_stop',
    stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
    usage: asUsage(inputTokens, outputTokens),
  }
}

type ToolSlot = { id: string; name: string; args: string; preparingSent: boolean }

async function* streamChatCompletionsApi(
  client: OpenAI,
  request: ModelRequest,
  decodedModelId: string,
): AsyncGenerator<StreamEvent> {
  const maxTotalTokens = 8192
  const maxCompletionTokens = Math.min(request.maxTokens ?? 512, 2048, maxTotalTokens)
  const messages = buildChatCompletionMessages(request)
  const tools = request.tools.length ? formatChatTools(request.tools) : undefined

  const stream = await client.chat.completions.create({
    model: decodedModelId,
    messages,
    tools,
    tool_choice: tools ? 'auto' : undefined,
    stream: true,
    max_completion_tokens: maxCompletionTokens,
  }, { signal: request.signal })

  const slots = new Map<number, ToolSlot>()
  let inputTokens = 0
  let outputTokens = 0
  let emittedToolCalls = false

  function slotFor(idx: number): ToolSlot {
    let s = slots.get(idx)
    if (!s) {
      s = { id: '', name: '', args: '', preparingSent: false }
      slots.set(idx, s)
    }
    return s
  }

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta

    if (delta?.content) {
      yield { type: 'text_delta', content: delta.content }
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const slot = slotFor(idx)
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) {
          slot.name = tc.function.name
          if (!slot.preparingSent && slot.name) {
            slot.preparingSent = true
            const cid = slot.id || `pending_${idx}`
            yield { type: 'tool_preparing', id: cid, name: slot.name }
          }
        }
        if (tc.function?.arguments) {
          slot.args += tc.function.arguments
          const cid = slot.id || `pending_${idx}`
          yield { type: 'tool_arg_delta', id: cid, delta: tc.function.arguments }
        }
      }
    }

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens
    }

    const fr = choice?.finish_reason
    if (fr === 'tool_calls') {
      const ordered = [...slots.entries()].sort((a, b) => a[0] - b[0])
      for (const [idx, slot] of ordered) {
        if (!slot.name) continue
        let parsedInput: unknown = {}
        try {
          parsedInput = JSON.parse(slot.args || '{}')
        } catch {
          parsedInput = {}
        }
        const cid = slot.id || `pending_${idx}`
        yield {
          type: 'tool_use_start',
          id: cid,
          name: slot.name,
          input: parsedInput,
        }
        emittedToolCalls = true
      }
      slots.clear()
    }
  }

  if (!emittedToolCalls && [...slots.values()].some(s => s.name)) {
    const ordered = [...slots.entries()].sort((a, b) => a[0] - b[0])
    for (const [idx, slot] of ordered) {
      if (!slot.name) continue
      let parsedInput: unknown = {}
      try {
        parsedInput = JSON.parse(slot.args || '{}')
      } catch {
        parsedInput = {}
      }
      const cid = slot.id || `pending_${idx}`
      yield {
        type: 'tool_use_start',
        id: cid,
        name: slot.name,
        input: parsedInput,
      }
      emittedToolCalls = true
    }
  }

  yield {
    type: 'message_stop',
    stopReason: emittedToolCalls ? 'tool_use' : 'end_turn',
    usage: asUsage(inputTokens, outputTokens),
  }
}

export class HuggingFaceSpaceProvider implements ModelProvider {
  async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const decoded = decodeHuggingFaceSpaceModelId(request.model)
    if (!decoded) {
      throw new Error('Invalid Hugging Face Space model id. Re-select the model in Settings.')
    }

    const space = getHuggingFaceSpace(decoded.spaceId)
    if (!space) {
      throw new Error(`Hugging Face Space ${decoded.spaceId} is not configured. Re-add it in Settings.`)
    }

    const apiKey = request.apiKeyOverride ?? await getDecryptedApiKeyOrNull('huggingface-space') ?? undefined
    const client = createClient(space.baseUrl, apiKey)

    try {
      yield* streamResponsesApi(client, request, decoded.modelId)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (!responsesEndpointLikelyUnsupported(err)) throw err
      yield* streamChatCompletionsApi(client, request, decoded.modelId)
    }
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return []
  }
}
