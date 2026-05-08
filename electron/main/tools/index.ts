import { fileReadTool } from './fileRead'
import { fileWriteTool } from './fileWrite'
import { fileEditTool } from './fileEdit'
import { globTool } from './glob'
import { grepTool } from './grep'
import { bashTool } from './bash'
import { webFetchTool } from './webFetch'
import { webSearchTool } from './webSearch'
import { subAgentTool } from './subAgent'
import { askUserTool } from './askUser'
import { todoWriteTool } from './todoWrite'
import { enterPlanModeTool, exitPlanModeTool } from './planMode'
import type { AgentEvent } from '../agent/query'
import { buildConnectedAppTools } from '../apps/manager'
import { buildMcpTools } from '../mcp/manager'
import { readSkillTool, readAppSkillTool } from '../skills/manager'
import { readRuleTool } from '../rules/manager'
import { meetingTools } from './meetings'
import { automationTools } from './automations'
import { projectTools } from './projects'
import { buildPluginToolsSync } from '../plugins/loader'
import { CONTEXT_TOOLS } from './context'
import path from 'node:path'

export interface ToolContext {
  workspacePath: string | null
  signal: AbortSignal
  yieldEvent: (event: AgentEvent) => void | Promise<void>
  onPermissionRequest: (toolName: string, toolId: string, args: unknown) => Promise<'allow' | 'allow-session' | 'deny'>
  onAskUser: (question: string, questionId: string, choices?: string[], extras?: import('../../../src/types').AskUserExtras) => Promise<string>
  toolId?: string
  /** Parent conversation history — available to Task (subagent) tool for fork mode. */
  parentMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: unknown }>
  /** Parent conversation model/mode — inherited by spawned subagents so they don't drift to DB default. */
  parentModel?: string
  parentMode?: 'default' | 'plan' | 'yolo'
  parentReasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  parentApiKeyOverride?: string
  /** Conversation id of the running turn. Tools that need to persist ledger
   * rows (e.g. Task subagent → subagent_runs / tasks) read this. */
  conversationId?: string
  /**
   * Active agent pack key ("wos", "meeting", "projects", "automation").
   * Set by the kernel from the AgentRunner; passed into hooks so per-agent
   * scoped hooks fire only when the right pack is running.
   */
  agentKey?: string
  /** Arbitrary side-channel key/value passthrough (e.g. conversationId, reasoningEffort). */
  extras?: Record<string, unknown>
}

export interface ToolResult {
  output: string | object
  error?: string
}

export interface Tool {
  name: string
  description: string
  inputSchema: object
  /** When true, this tool only reads data and does not modify state. */
  readOnly?: boolean
  /** Capability tags consumed by AgentDef.acceptedTags filtering.
   *  Examples: "meetings", "projects", "mcp", "plugins", "apps:slack",
   *  "apps:github", etc. Tools without tags are universal — every agent
   *  sees them. */
  tags?: string[]
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

const BUILTIN_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
  bashTool,
  webFetchTool,
  webSearchTool,
  subAgentTool,
  askUserTool,
  todoWriteTool,
  enterPlanModeTool,
  exitPlanModeTool,
]

/**
 * Tool name pattern accepted by both OpenAI and Anthropic APIs. We sanitize
 * here because dynamic sources (MCP servers, Apps) can produce names that
 * include `.` or other illegal chars, which would otherwise blow up EVERY
 * chat turn with a 400 from the provider.
 */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function ensureValidNames(tools: Tool[], origin: string): Tool[] {
  return tools.map(t => {
    if (VALID_TOOL_NAME.test(t.name)) return t
    const safe = sanitizeToolName(t.name)
    console.warn(`[tools] sanitized illegal tool name '${t.name}' from ${origin} -> '${safe}'`)
    return { ...t, name: safe }
  })
}

function withTags(tools: Tool[], ...tags: string[]): Tool[] {
  return tools.map(t => {
    const existing = Array.isArray(t.tags) ? t.tags : []
    const merged = [...existing]
    for (const tag of tags) if (!merged.includes(tag)) merged.push(tag)
    return { ...t, tags: merged }
  })
}

/**
 * Dynamically-composed tool registry. App tools (Slack), MCP proxies, and
 * Skills/Rules helpers are added here at agent-loop start time — that way
 * connecting a new app doesn't require restarting the process.
 */
export function getAllTools(): Tool[] {
  return [
    ...BUILTIN_TOOLS,
    readSkillTool,
    readAppSkillTool,
    readRuleTool,
    ...ensureValidNames(withTags(CONTEXT_TOOLS, 'context'), 'context'),
    ...ensureValidNames(withTags(meetingTools, 'meetings'), 'meetings'),
    ...ensureValidNames(withTags(automationTools, 'automations'), 'automations'),
    ...ensureValidNames(withTags(projectTools, 'projects'), 'projects'),
    ...ensureValidNames(buildConnectedAppTools(), 'apps'),
    ...ensureValidNames(withTags(buildMcpTools(), 'mcp'), 'mcp'),
    ...ensureValidNames(withTags(buildPluginToolsSync(), 'plugins'), 'plugins'),
  ]
}

// Back-compat export — some call sites still import the static list.
export const tools: Tool[] = BUILTIN_TOOLS

export async function executeTools(
  toolName: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const all = getAllTools()
  const tool = all.find(t => t.name === toolName)
  if (!tool) return { output: null as unknown as string, error: `Unknown tool: ${toolName}` }

  const { runPreToolUse, runPostToolUse, runOnError } = await import('../hooks/manager')
  const hookCtx = {
    workspacePath: context.workspacePath ?? null,
    agentKey: context.agentKey,
  }

  const pre = await runPreToolUse(toolName, input, hookCtx)
  if (pre.block) {
    return {
      output: '',
      error: `Blocked by hook: ${pre.reason ?? 'pre-tool-use hook returned block'}`,
    }
  }

  let result: ToolResult
  try {
    result = await tool.execute(pre.args, context)
  } catch (err) {
    const handled = await runOnError(toolName, err, hookCtx)
    if (handled.handled && handled.result !== undefined) {
      return handled.result as ToolResult
    }
    throw err
  }

  const mutated = await runPostToolUse(toolName, pre.args, result, hookCtx)
  return (mutated as ToolResult) ?? result
}

export function validatePath(filePath: string, workspacePath: string | null): void {
  if (!workspacePath) return
  const resolved = path.resolve(filePath)
  const workspace = path.resolve(workspacePath)
  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    throw new Error(`Access denied: '${filePath}' is outside workspace '${workspacePath}'`)
  }
}
