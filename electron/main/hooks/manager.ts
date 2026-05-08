/**
 * Central hook dispatcher (Claude-Code-style hook matrix).
 *
 * Hooks are opt-in extension points wired around tool execution and app
 * lifecycle. Apps register handlers via `registerHooks()`; the dispatcher
 * runs them in registration order with a permissive contract — any handler
 * may mutate the args/result, return `{ block: true }` to abort, or simply
 * observe.
 *
 * Hooks added here:
 *   - PreToolUse(toolName, args, ctx)   → may mutate args or block
 *   - PostToolUse(toolName, args, result, ctx) → may mutate result, log
 *   - OnConnect(appId, creds, ctx)      → fired after `connectApp` succeeds
 *   - OnDisconnect(appId, ctx)          → fired after `disconnectApp`
 *   - OnError(toolName, error, ctx)     → optional retry/fallback
 *   - Notification(level, message, ctx) → push to UI/tray
 *   - BeforeSubagent(name, args, ctx)   → may mutate args or block
 *
 * Every hook is best-effort: a failure inside one hook never crashes the
 * caller — it logs and continues, with the original args/result preserved.
 */

export interface HookContext {
  /** Optional workspace path from the active agent run. */
  workspacePath?: string | null
  /** Source of the hook ("user", "app:slack", etc.) — set automatically. */
  source?: string
  /**
   * Active agent pack key ("wos", "meeting", "projects", "automation").
   * Set by the agent kernel before dispatching a tool/subagent. When set,
   * the dispatcher skips hooks whose `agentScope` doesn't include it.
   */
  agentKey?: string
  [key: string]: unknown
}

export type PreToolUseResult = { block?: boolean; reason?: string; args?: unknown } | void
export type PostToolUseResult = { result?: unknown } | void
export type OnErrorResult = { handled?: boolean; result?: unknown } | void
export type BeforeSubagentResult = { block?: boolean; reason?: string; args?: unknown } | void

export interface HookHandlers {
  PreToolUse?: (toolName: string, args: unknown, ctx: HookContext) => PreToolUseResult | Promise<PreToolUseResult>
  PostToolUse?: (toolName: string, args: unknown, result: unknown, ctx: HookContext) => PostToolUseResult | Promise<PostToolUseResult>
  OnConnect?: (appId: string, creds: Record<string, string>, ctx: HookContext) => void | Promise<void>
  OnDisconnect?: (appId: string, ctx: HookContext) => void | Promise<void>
  OnError?: (toolName: string, error: unknown, ctx: HookContext) => OnErrorResult | Promise<OnErrorResult>
  Notification?: (level: 'info' | 'warning' | 'error', message: string, ctx: HookContext) => void | Promise<void>
  BeforeSubagent?: (name: string, args: unknown, ctx: HookContext) => BeforeSubagentResult | Promise<BeforeSubagentResult>
}

export interface RegisterHookOptions {
  /**
   * Limit this hook to specific agent packs. When omitted the hook is
   * global (back-compat — every dispatch runs it). When set, the hook only
   * runs if the dispatch context's `agentKey` is in the list.
   */
  agentScope?: string[]
}

interface RegisteredHook {
  source: string
  handlers: HookHandlers
  agentScope?: string[]
}

const REGISTRY: RegisteredHook[] = []

export function registerHooks(source: string, handlers: HookHandlers, options: RegisterHookOptions = {}): void {
  REGISTRY.push({ source, handlers, agentScope: options.agentScope })
}

export function clearHooks(source?: string): void {
  if (!source) {
    REGISTRY.length = 0
    return
  }
  for (let i = REGISTRY.length - 1; i >= 0; i--) {
    if (REGISTRY[i].source === source) REGISTRY.splice(i, 1)
  }
}

export function listHooks(): Array<{ source: string; events: string[]; agentScope?: string[] }> {
  return REGISTRY.map(h => ({
    source: h.source,
    events: Object.keys(h.handlers),
    agentScope: h.agentScope,
  }))
}

function logHookError(event: string, source: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  console.warn(`[hooks] ${event} handler from "${source}" failed: ${msg}`)
}

/**
 * Returns true if the hook should run given the dispatch context.
 * - Global hooks (no agentScope) always run.
 * - Scoped hooks only run when ctx.agentKey is one of their scopes.
 * - If ctx has no agentKey (caller didn't tag the dispatch), scoped hooks
 *   are skipped — global behaviour wins by default.
 */
function isHookActive(hook: RegisteredHook, ctx: HookContext): boolean {
  if (!hook.agentScope || hook.agentScope.length === 0) return true
  if (!ctx.agentKey) return false
  return hook.agentScope.includes(ctx.agentKey)
}

export async function runPreToolUse(
  toolName: string,
  args: unknown,
  ctx: HookContext = {},
): Promise<{ block: boolean; reason?: string; args: unknown }> {
  let currentArgs = args
  for (const hook of REGISTRY) {
    if (!hook.handlers.PreToolUse) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      const ret = await hook.handlers.PreToolUse(toolName, currentArgs, { ...ctx, source: hook.source })
      if (!ret) continue
      if (ret.block) return { block: true, reason: ret.reason, args: currentArgs }
      if ('args' in ret && ret.args !== undefined) currentArgs = ret.args
    } catch (err) {
      logHookError('PreToolUse', hook.source, err)
    }
  }
  return { block: false, args: currentArgs }
}

export async function runPostToolUse(
  toolName: string,
  args: unknown,
  result: unknown,
  ctx: HookContext = {},
): Promise<unknown> {
  let currentResult = result
  for (const hook of REGISTRY) {
    if (!hook.handlers.PostToolUse) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      const ret = await hook.handlers.PostToolUse(toolName, args, currentResult, { ...ctx, source: hook.source })
      if (ret && 'result' in ret && ret.result !== undefined) currentResult = ret.result
    } catch (err) {
      logHookError('PostToolUse', hook.source, err)
    }
  }
  return currentResult
}

export async function runOnConnect(appId: string, creds: Record<string, string>, ctx: HookContext = {}): Promise<void> {
  for (const hook of REGISTRY) {
    if (!hook.handlers.OnConnect) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      await hook.handlers.OnConnect(appId, creds, { ...ctx, source: hook.source })
    } catch (err) {
      logHookError('OnConnect', hook.source, err)
    }
  }
}

export async function runOnDisconnect(appId: string, ctx: HookContext = {}): Promise<void> {
  for (const hook of REGISTRY) {
    if (!hook.handlers.OnDisconnect) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      await hook.handlers.OnDisconnect(appId, { ...ctx, source: hook.source })
    } catch (err) {
      logHookError('OnDisconnect', hook.source, err)
    }
  }
}

export async function runOnError(toolName: string, error: unknown, ctx: HookContext = {}): Promise<{ handled: boolean; result?: unknown }> {
  for (const hook of REGISTRY) {
    if (!hook.handlers.OnError) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      const ret = await hook.handlers.OnError(toolName, error, { ...ctx, source: hook.source })
      if (ret?.handled) return { handled: true, result: ret.result }
    } catch (err) {
      logHookError('OnError', hook.source, err)
    }
  }
  return { handled: false }
}

export async function emitNotification(level: 'info' | 'warning' | 'error', message: string, ctx: HookContext = {}): Promise<void> {
  for (const hook of REGISTRY) {
    if (!hook.handlers.Notification) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      await hook.handlers.Notification(level, message, { ...ctx, source: hook.source })
    } catch (err) {
      logHookError('Notification', hook.source, err)
    }
  }
}

export async function runBeforeSubagent(
  name: string,
  args: unknown,
  ctx: HookContext = {},
): Promise<{ block: boolean; reason?: string; args: unknown }> {
  let currentArgs = args
  for (const hook of REGISTRY) {
    if (!hook.handlers.BeforeSubagent) continue
    if (!isHookActive(hook, ctx)) continue
    try {
      const ret = await hook.handlers.BeforeSubagent(name, currentArgs, { ...ctx, source: hook.source })
      if (!ret) continue
      if (ret.block) return { block: true, reason: ret.reason, args: currentArgs }
      if ('args' in ret && ret.args !== undefined) currentArgs = ret.args
    } catch (err) {
      logHookError('BeforeSubagent', hook.source, err)
    }
  }
  return { block: false, args: currentArgs }
}
