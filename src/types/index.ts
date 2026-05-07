export type AgentMode = 'default' | 'plan' | 'yolo'
export type ViewType = 'home' | 'chat' | 'settings' | 'apps' | 'meetings' | 'automations' | 'projects'

/**
 * Render-component protocol for `ask_user`. The agent declares the kind of
 * input it wants from the user and ChatView renders the matching component
 * inline. `kind` is optional/back-compat: omitting it means plain text
 * (or 'choice' if `choices` is set).
 */
export type AskUserKind = 'text' | 'choice' | 'confirm' | 'fileDrop' | 'picker' | 'form'

export interface AskUserFormField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean'
  placeholder?: string
  required?: boolean
}

export interface AskUserExtras {
  /** Render kind. If omitted, treat as 'text' (or 'choice' when `choices` set). */
  kind?: AskUserKind
  /** For fileDrop: accepted MIME types or extensions. */
  accept?: string[]
  /** For picker: source registry name (channel|repo|meeting|calendar). */
  source?: 'channel' | 'repo' | 'meeting' | 'calendar'
  /** For picker: allow multiple selections. */
  multi?: boolean
  /** For choice: also allow free-text answer. */
  allowFreeform?: boolean
  /** For form: schema. */
  fields?: AskUserFormField[]
  /**
   * For picker: pre-populated choices from the snapshot cache.
   * Each item has at minimum `id` and `label`; additional fields vary by source.
   * The renderer can display a real picker UI from these items.
   */
  pickerChoices?: Array<{ id: string; label: string; [key: string]: unknown }>
  /**
   * Unix ms timestamp of the snapshot's fetchedAt when it was stale (> 24h old).
   * If present, the UI can show a "refresh" affordance.
   */
  staleAt?: number
}

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_preparing'; toolName: string; toolId: string }
  | { type: 'tool_arg_delta'; toolId: string; delta: string }
  | { type: 'tool_stdout_delta'; toolId: string; delta: string }
  | { type: 'tool_stderr_delta'; toolId: string; delta: string }
  | { type: 'tool_use_start'; toolName: string; toolId: string; input: unknown }
  | { type: 'tool_result'; toolId: string; result: unknown; error?: string }
  | { type: 'subagent_start'; agentId: string; prompt: string; agentName?: string; colorSeed?: number }
  | { type: 'subagent_event'; agentId: string; event: AgentEvent; agentName?: string; colorSeed?: number }
  | { type: 'subagent_end'; agentId: string; result: string; agentName?: string; colorSeed?: number }
  | { type: 'subagent_focus'; agentId: string | null }
  | { type: 'permission_request'; toolName: string; toolId: string; args: unknown }
  | { type: 'permission_decided'; toolId: string; decision: 'allowed' | 'denied' }
  | { type: 'ask_user'; question: string; questionId: string; choices?: string[]; extras?: AskUserExtras }
  | { type: 'ask_user_answered'; questionId: string; answer: string }
  | { type: 'plan_ready' }
  | { type: 'turn_start' }
  | { type: 'turn_complete'; usage: { inputTokens: number; outputTokens: number }; reason?: 'end_turn' | 'tool_use' | 'aborted' | 'error' }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'compact_started' }
  | { type: 'compact_complete'; summary: string }

export type MessageBlock =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string; collapsed?: boolean; done?: boolean; interrupted?: boolean }
  | { type: 'tool_use'; toolName: string; toolId: string; input: unknown; partialArgs?: string; status: 'preparing' | 'running' | 'done' | 'error'; result?: unknown; error?: string; stdout?: string; stderr?: string; interrupted?: boolean }
  | { type: 'tool_result'; toolId: string; result: unknown; error?: string }
  | { type: 'subagent'; agentId: string; prompt: string; events: AgentEvent[]; result?: string; collapsed?: boolean; interrupted?: boolean; agentName?: string; colorSeed?: number; startedAt?: number }
  | { type: 'permission_request'; toolName: string; toolId: string; args: unknown; decision?: 'allowed' | 'denied'; interrupted?: boolean }
  | { type: 'ask_user'; question: string; questionId: string; choices?: string[]; answer?: string; interrupted?: boolean; extras?: AskUserExtras }
  | { type: 'diff'; filePath: string; diff: string; collapsed?: boolean }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'compact_notice'; summary: string }

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: MessageBlock[]
  createdAt: Date
  branchGroupId?: string | null
  branchIndex?: number | null
}

export interface Conversation {
  id: string
  title: string
  workspaceId: string | null
  model: string
  mode: AgentMode
  createdAt: Date
  updatedAt: Date
  tokenCount: number
  contextLimit: number
  isCompacted: boolean
}

export interface Workspace {
  id: string
  path: string
  name: string
  addedAt: Date
  lastAccessedAt: Date | null
}

export interface ModelInfo {
  id: string
  name: string
  provider: 'openai' | 'anthropic' | 'huggingface-space'
  contextWindow?: number
  supportsReasoning?: boolean
  supportsVision?: boolean
  description?: string
}

export interface FileAttachment {
  name: string
  content: string
  type: string
}

export interface Settings {
  defaultModel: string
  reasoningEffort: 'low' | 'medium' | 'high' | 'max'
  defaultMode: AgentMode
  theme: 'dark' | 'light' | 'system'
  activeWorkspaceId: string | null
  intentModel: string
  intentEnabled: boolean
  maxSubagentDepth: number
  maxSubagentBreadth: number
  memoryEnabled: boolean
}
