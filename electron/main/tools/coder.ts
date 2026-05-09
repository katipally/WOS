import type { Tool, ToolContext, ToolResult } from './index'
import { runSingleSubAgent } from './subAgent'

interface CoderInput {
  task: string
  files?: string[]
  language?: string
  mode?: 'implement' | 'debug' | 'review' | 'test'
  repo_context?: string
  constraints?: string
  return_format?: 'diff' | 'summary' | 'full'
}

export const delegateToCoderTool: Tool = {
  name: 'delegate_to_coder',
  description:
    'Delegate any programming or coding task to the specialized Coding Agent. ' +
    'Use this for ALL code-related work: implementing features, debugging errors, ' +
    'refactoring, code review, writing tests, any task that involves reading or ' +
    'modifying source code files. The coding agent runs a full agentic loop: it ' +
    'reads files, makes edits, runs tests, fixes failures, and returns a result.',
  tags: ['orchestration'],
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Clear, specific description of the coding task.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relevant file paths to focus on.',
      },
      language: {
        type: 'string',
        description: 'Programming language (e.g. typescript, python, rust, go).',
      },
      mode: {
        type: 'string',
        enum: ['implement', 'debug', 'review', 'test'],
        description:
          'Type of coding task: implement (new feature), debug (fix error), ' +
          'review (analyze code), test (write tests).',
      },
      repo_context: {
        type: 'string',
        description: 'Brief description of the codebase, framework, or conventions.',
      },
      constraints: {
        type: 'string',
        description:
          'Constraints: e.g. no breaking changes, minimal diff, match existing patterns.',
      },
      return_format: {
        type: 'string',
        enum: ['diff', 'summary', 'full'],
        description:
          'Response format: diff (unified diff), summary (2-3 sentences), ' +
          'full (complete updated files + explanation).',
      },
    },
    required: ['task'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const i = input as CoderInput
    const prompt = buildCoderPrompt(i)
    return runSingleSubAgent(
      {
        description: `coding: ${i.task.slice(0, 60)}`,
        prompt,
        preset: 'code',
        fork: false,
      },
      ctx,
    )
  },
}

function buildCoderPrompt(i: CoderInput): string {
  const parts: string[] = []

  const modeLabel: Record<string, string> = {
    implement: 'IMPLEMENT',
    debug: 'DEBUG',
    review: 'REVIEW',
    test: 'TEST',
  }

  parts.push(`## ${modeLabel[i.mode ?? ''] ?? 'CODING TASK'}`)
  parts.push('')
  parts.push(i.task)

  if (i.language) {
    parts.push(`\nLanguage: ${i.language}`)
  }

  if (i.files && i.files.length > 0) {
    parts.push(`\nFocus on these files:\n${i.files.map(f => `  - ${f}`).join('\n')}`)
  }

  if (i.repo_context) {
    parts.push(`\nCodebase context:\n${i.repo_context}`)
  }

  if (i.constraints) {
    parts.push(`\nConstraints:\n${i.constraints}`)
  }

  if (i.return_format) {
    const fmt: Record<string, string> = {
      diff: 'Return a unified diff showing all changes made.',
      summary: 'Return a brief 2-3 sentence summary of what was done and why.',
      full: 'Return the full updated file contents with explanation.',
    }
    const instruction = fmt[i.return_format]
    if (instruction) parts.push(`\nOutput format: ${instruction}`)
  }

  return parts.join('\n')
}
