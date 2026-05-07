import type { MessageBlock, AgentEvent } from '../types'

export function applyEvent(blocks: MessageBlock[], event: AgentEvent): MessageBlock[] {
  switch (event.type) {
    case 'text_delta': {
      // Mark active reasoning as done when text starts (auto-collapse cue)
      const markedDone = blocks.map(b =>
        b.type === 'reasoning' && !b.done ? { ...b, done: true, collapsed: true } : b
      )
      const last = markedDone[markedDone.length - 1]
      if (last?.type === 'text') {
        return [
          ...markedDone.slice(0, -1),
          { ...last, content: last.content + event.content },
        ]
      }
      return [...markedDone, { type: 'text', content: event.content }]
    }

    case 'reasoning_delta': {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'reasoning' && !last.done) {
        return [
          ...blocks.slice(0, -1),
          { ...last, content: last.content + event.content },
        ]
      }
      return [...blocks, { type: 'reasoning', content: event.content, collapsed: false, done: false }]
    }

    // Some providers emit "thinking_delta" instead of "reasoning_delta".
    // In the UI we treat these identically: a collapsible reasoning block that
    // auto-collapses when the assistant starts emitting final text.
    case 'thinking_delta': {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'reasoning' && !last.done) {
        return [
          ...blocks.slice(0, -1),
          { ...last, content: last.content + event.content },
        ]
      }
      return [...blocks, { type: 'reasoning', content: event.content, collapsed: false, done: false }]
    }

    case 'turn_start':
      return blocks

    case 'turn_complete':
      return blocks.map(b =>
        b.type === 'reasoning' && !b.done ? { ...b, done: true, collapsed: true } : b
      )

    case 'tool_preparing':
      return [
        ...blocks,
        {
          type: 'tool_use',
          toolName: event.toolName,
          toolId: event.toolId,
          input: {},
          partialArgs: '',
          status: 'preparing',
        },
      ]

    case 'tool_arg_delta':
      return blocks.map(b =>
        b.type === 'tool_use' && b.toolId === event.toolId
          ? { ...b, partialArgs: (b.partialArgs ?? '') + event.delta }
          : b
      )

    case 'tool_stdout_delta':
      return blocks.map(b =>
        b.type === 'tool_use' && b.toolId === event.toolId
          ? { ...b, stdout: (b.stdout ?? '') + event.delta }
          : b
      )

    case 'tool_stderr_delta':
      return blocks.map(b =>
        b.type === 'tool_use' && b.toolId === event.toolId
          ? { ...b, stderr: (b.stderr ?? '') + event.delta }
          : b
      )

    case 'tool_use_start': {
      const existing = blocks.find(b => b.type === 'tool_use' && b.toolId === event.toolId)
      if (existing) {
        // Upgrade the preparing block to running with final parsed input
        return blocks.map(b =>
          b.type === 'tool_use' && b.toolId === event.toolId
            ? { ...b, input: event.input, status: 'running' as const, partialArgs: undefined }
            : b
        )
      }
      return [
        ...blocks,
        {
          type: 'tool_use',
          toolName: event.toolName,
          toolId: event.toolId,
          input: event.input,
          status: 'running',
        },
      ]
    }

    case 'tool_result':
      return blocks.map(b =>
        b.type === 'tool_use' && b.toolId === event.toolId
          ? {
              ...b,
              status: event.error ? 'error' as const : 'done' as const,
              result: event.result,
              error: event.error,
            }
          : b
      )

    case 'permission_request':
      return [
        ...blocks,
        {
          type: 'permission_request',
          toolName: event.toolName,
          toolId: event.toolId,
          args: event.args,
        },
      ]

    case 'permission_decided':
      return blocks.map(b =>
        b.type === 'permission_request' && b.toolId === event.toolId
          ? { ...b, decision: event.decision }
          : b
      )

    case 'ask_user':
      return [
        ...blocks,
        {
          type: 'ask_user',
          question: event.question,
          questionId: event.questionId,
          choices: event.choices,
          extras: event.extras,
        },
      ]

    case 'ask_user_answered':
      return blocks.map(b =>
        b.type === 'ask_user' && b.questionId === event.questionId
          ? { ...b, answer: event.answer }
          : b
      )

    case 'subagent_start':
      return [
        ...blocks,
        {
          type: 'subagent',
          agentId: event.agentId,
          prompt: event.prompt,
          events: [],
          collapsed: false,
          agentName: event.agentName,
          colorSeed: event.colorSeed,
          startedAt: Date.now(),
        },
      ]

    case 'subagent_event':
      return blocks.map(b =>
        b.type === 'subagent' && b.agentId === event.agentId
          ? { ...b, events: [...b.events, event.event] }
          : b
      )

    case 'subagent_end':
      return blocks.map(b =>
        b.type === 'subagent' && b.agentId === event.agentId
          ? { ...b, result: event.result, collapsed: true }
          : b
      )

    case 'error':
      return [...blocks, { type: 'error', message: event.message, retryable: event.retryable }]

    case 'compact_complete':
      return [...blocks, { type: 'compact_notice', summary: event.summary }]

    case 'plan_ready': {
      // Idempotent: avoid duplicate "Plan complete" notices when plan_ready
      // fires more than once per turn.
      const marker = '*Plan complete. Waiting for approval...*'
      const already = blocks.some(b => b.type === 'text' && b.content.includes(marker))
      if (already) return blocks
      return [...blocks, { type: 'text', content: `\n\n---\n${marker}\n` }]
    }

    default:
      return blocks
  }
}

/**
 * Reconcile blocks that were left "alive" because the previous run was interrupted
 * (app crash, hard kill, hot-reload, or aborted streaming). Called when loading
 * a persisted conversation so revisited chats don't show fake "running…" state.
 *
 * Returns the same array reference if nothing needed fixing.
 */
export function finalizeOrphanBlocks(
  blocks: MessageBlock[],
  opts: { isLatestMessage?: boolean } = {}
): MessageBlock[] {
  const { isLatestMessage = false } = opts
  let mutated = false
  const out = blocks.map((b): MessageBlock => {
    if (b.type === 'tool_use' && (b.status === 'preparing' || b.status === 'running')) {
      mutated = true
      return {
        ...b,
        status: 'error' as const,
        error: b.error || 'Interrupted — previous run did not finish',
        // Only mark interrupted (shows the banner) for the most recent message.
        // Older messages are just cleaned up silently.
        interrupted: isLatestMessage || undefined,
      }
    }
    if (b.type === 'reasoning' && !b.done) {
      mutated = true
      return { ...b, done: true, collapsed: true, interrupted: isLatestMessage || undefined }
    }
    if (b.type === 'ask_user' && !b.answer) {
      mutated = true
      return { ...b, answer: '__cancelled__', interrupted: isLatestMessage || undefined }
    }
    if (b.type === 'permission_request' && !b.decision) {
      mutated = true
      return { ...b, decision: 'denied' as const, interrupted: isLatestMessage || undefined }
    }
    if (b.type === 'subagent' && !b.result) {
      mutated = true
      return { ...b, result: '[interrupted]', collapsed: true, interrupted: isLatestMessage || undefined }
    }
    return b
  })
  return mutated ? out : blocks
}

export function blocksHaveInterruption(blocks: MessageBlock[]): boolean {
  return blocks.some(b => 'interrupted' in b && (b as { interrupted?: boolean }).interrupted === true)
}
