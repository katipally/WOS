import type { ConversationMessage } from '../providers/types'

/** Rough token estimate: ~4 characters per token (conservative). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b: unknown) => {
      if (!b || typeof b !== 'object') return ''
      const block = b as Record<string, unknown>
      if (block.type === 'text') return String(block.text ?? '')
      if (block.type === 'tool_use') return JSON.stringify(block.input ?? {})
      if (block.type === 'tool_result') return JSON.stringify(block.content ?? '')
      return ''
    }).join('\n')
  }
  return JSON.stringify(content)
}

/**
 * Estimates the total token count for a provider call before making it.
 * Used to decide whether to compact before hitting the context limit.
 */
export function estimateConversationTokens(
  messages: ConversationMessage[],
  systemPrompt: string,
  tools: unknown[],
): number {
  let total = estimateTokens(systemPrompt)

  for (const m of messages) {
    total += estimateTokens(contentToText(m.content))
    total += 4 // role overhead
  }

  // Tool definitions can be a *major* part of the prompt. Estimating a flat
  // per-tool overhead wildly over/under counts depending on schema size, and
  // makes the UI/context compaction behave unpredictably. Approximate by the
  // serialized payload size instead.
  if (tools.length > 0) {
    try {
      total += estimateTokens(JSON.stringify(tools))
    } catch {
      // Fallback: conservative flat estimate if serialization fails.
      total += tools.length * 200
    }
  }

  // Safety buffer: add 5% for formatting/metadata
  return Math.ceil(total * 1.05)
}
