import Anthropic from '@anthropic-ai/sdk'
import type {
  ModelProvider, ModelRequest, StreamEvent, ModelInfo
} from './types'
import { getDecryptedApiKeyForInstance } from './keystore'
import { enrichModel, modelSupportsReasoning } from './capabilities'

function mapReasoningToThinkingBudget(effort: string | undefined, maxTokens: number): number | undefined {
  if (maxTokens <= 1024) return undefined
  const map: Record<string, number> = {
    low: 1024,
    medium: 4096,
    high: 8192,
    max: 12000,
  }
  const requested = map[effort ?? 'medium'] ?? map.medium
  return Math.min(requested, maxTokens - 1024)
}

function formatMessages(messages: ModelRequest['messages']): Anthropic.MessageParam[] {
  return messages.map(m => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content }
    }
    return {
      role: m.role,
      content: (m.content as Anthropic.ContentBlockParam[]),
    }
  })
}

function formatTools(tools: ModelRequest['tools']): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }))
}

export class AnthropicProvider implements ModelProvider {
  private readonly providerId: string
  private toolInputAccumulators: Map<number, string> = new Map()
  private toolInfoByIndex: Map<number, { id: string; name: string }> = new Map()

  constructor(opts: { providerId?: string } = {}) {
    this.providerId = opts.providerId ?? 'anthropic'
  }

  async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const apiKey = request.apiKeyOverride ?? await getDecryptedApiKeyForInstance(request.providerId ?? this.providerId)
    const client = new Anthropic({ apiKey })
    const maxTokens = request.maxTokens ?? 16384
    const supportsReasoning = modelSupportsReasoning(request.model)
    const thinkingBudget = supportsReasoning
      ? mapReasoningToThinkingBudget(request.reasoningEffort, maxTokens)
      : undefined

    this.toolInputAccumulators.clear()
    this.toolInfoByIndex.clear()

    let inputTokens = 0
    let outputTokens = 0
    const completedTools: Array<{ id: string; name: string; input: unknown }> = []

    try {
      const stream = client.messages.stream(
        {
          model: request.model,
          system: request.systemPrompt || undefined,
          messages: formatMessages(request.messages),
          tools: formatTools(request.tools),
          max_tokens: maxTokens,
          ...(thinkingBudget !== undefined
            ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
            : {}),
        },
        { signal: request.signal },
      )

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens
            break

          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              this.toolInfoByIndex.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
              })
              this.toolInputAccumulators.set(event.index, '')
              yield { type: 'tool_preparing', id: event.content_block.id, name: event.content_block.name }
            }
            break

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', content: event.delta.text }
            } else if (event.delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', content: event.delta.thinking }
            } else if (event.delta.type === 'input_json_delta') {
              const current = this.toolInputAccumulators.get(event.index) ?? ''
              this.toolInputAccumulators.set(event.index, current + event.delta.partial_json)
              const info = this.toolInfoByIndex.get(event.index)
              if (info) {
                yield { type: 'tool_arg_delta', id: info.id, delta: event.delta.partial_json }
              }
            }
            break

          case 'content_block_stop': {
            const toolInfo = this.toolInfoByIndex.get(event.index)
            if (toolInfo) {
              const jsonStr = this.toolInputAccumulators.get(event.index) ?? '{}'
              let parsedInput: unknown = {}
              try { parsedInput = JSON.parse(jsonStr) } catch { parsedInput = {} }
              completedTools.push({ ...toolInfo, input: parsedInput })
              yield { type: 'tool_use_start', id: toolInfo.id, name: toolInfo.name, input: parsedInput }
            }
            break
          }

          case 'message_delta': {
            if (typeof event.usage?.output_tokens === 'number') {
              outputTokens = event.usage.output_tokens
            }
            // Only emit a terminal stop when the provider actually signals
            // stop_reason. Intermediate message_delta events (usage updates)
            // shouldn't be treated as end-of-turn.
            const stopReason = event.delta?.stop_reason
            if (stopReason) {
              yield {
                type: 'message_stop',
                stopReason:
                  stopReason === 'tool_use' || completedTools.length > 0
                    ? 'tool_use'
                    : 'end_turn',
                usage: { inputTokens, outputTokens },
              }
            }
            break
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      // The Anthropic SDK sometimes wraps abort errors differently.
      if (request.signal?.aborted) return
      throw err
    }
  }

  async fetchModels(apiKey: string): Promise<ModelInfo[]> {
    const client = new Anthropic({ apiKey })
    const models = await client.models.list()
    return models.data.map(m => ({
      ...enrichModel({
        id: m.id,
        name: (m as { display_name?: string }).display_name ?? m.id,
      }),
      providerId: this.providerId,
      kind: 'anthropic' as const,
    }))
  }
}
