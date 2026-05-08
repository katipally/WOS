import React, { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react'
import {
  Plus, ChevronDown, ChevronRight, ChevronLeft, Copy, Check,
  RefreshCw, ArrowDown, AlertCircle, Shield, Zap, BookOpen,
  File, Loader2, X, FileEdit, Pencil, Brain, HelpCircle, Search, Globe,
} from 'lucide-react'
import type { MessageBlock, DisplayMessage, FileAttachment, AgentEvent } from '../../../types'
import { useAgentStore } from '../../../store/agentStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useUIStore } from '../../../store/uiStore'
import { blocksHaveInterruption } from '../../../lib/blockAccumulator'
import { cn } from '../../../lib/utils'
import { toast } from 'sonner'
import { MicButton } from './MicButton'
import { ModelPickerModal } from './ModelPickerModal'

const MODES = [
  { id: 'default', label: 'Default', icon: Shield, description: 'Asks for permission on each action' },
  { id: 'plan', label: 'Plan', icon: BookOpen, description: 'Plans first, executes on approval' },
  { id: 'yolo', label: 'Yolo', icon: Zap, description: 'Fully autonomous — no interruptions' },
] as const

/* ─── No-workspace inline prompt (shown inside @-file picker when none selected) ─── */
function NoWorkspacePrompt({ onClose }: { onClose: () => void }) {
  const { workspaces, addWorkspace, setActiveWorkspace } = useWorkspaceStore()
  const hasWorkspaces = workspaces.length > 0
  return (
    <div className="px-3 py-3 flex flex-col gap-2">
      <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
        {hasWorkspaces ? 'No workspace is active. Pick one to browse files:' : 'No workspace selected. Add one to browse files:'}
      </div>
      {hasWorkspaces ? (
        <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
          {workspaces.map(ws => (
            <button
              key={ws.id}
              onMouseDown={async () => { await setActiveWorkspace(ws.id); onClose() }}
              className="text-left px-2 py-1 rounded text-xs wos-hover-sm"
              style={{ color: 'var(--foreground)' }}
            >
              {ws.name}
            </button>
          ))}
        </div>
      ) : null}
      <button
        onMouseDown={async () => { await addWorkspace(); onClose() }}
        className="text-left px-2 py-1 rounded text-xs flex items-center gap-1.5"
        style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
      >
        <Plus size={11} />
        <span>Add workspace folder…</span>
      </button>
    </div>
  )
}

/* ─── Markdown error boundary ───
   Any render exception inside MarkdownContent (mid-stream malformed markdown,
   third-party renderer crashes such as the historical "listblock not found"
   from upstream parsers, etc.) falls back to a <pre> dump of the raw text
   instead of unmounting the chat — which would otherwise cascade into
   "Message not found" errors when the user tries to edit. */
class MarkdownErrorBoundary extends React.Component<
  { rawText: string; children: React.ReactNode },
  { errored: boolean }
> {
  constructor(props: { rawText: string; children: React.ReactNode }) {
    super(props)
    this.state = { errored: false }
  }
  static getDerivedStateFromError() {
    return { errored: true }
  }
  componentDidCatch(error: Error) {
    console.warn('[wos] markdown render error — falling back to plain text:', error.message)
  }
  render() {
    if (this.state.errored) {
      return (
        <pre
          className="whitespace-pre-wrap text-[13px] leading-[1.7]"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'inherit' }}
        >
          {this.props.rawText}
        </pre>
      )
    }
    return this.props.children
  }
}

/* ─── Markdown / text renderer ─── */
function MarkdownContent({ content }: { content: string }) {
  const raw = (typeof content === 'string' ? content : String(content ?? '')).replace(/\n+$/, '')
  const lines = raw ? raw.split('\n') : []
  const result: React.ReactNode[] = []
  let codeLines: string[] = []
  let inCode = false
  let codeLang = ''
  let k = 0
  const key = () => `ml-${k++}`

  const renderInline = (str: string, pk: string): React.ReactNode => {
    if (typeof str !== 'string') return null
    const parts = str.split(/(\*\*[^*]+\*\*|`[^`]+`|\[([^\]]+)\]\(([^)]+)\))/g).filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    )
    return (
      <span key={pk}>
        {parts.map((p, i) => {
          if (p.startsWith('**') && p.endsWith('**')) {
            return <strong key={i} style={{ color: 'var(--foreground)' }}>{p.slice(2, -2)}</strong>
          }
          if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
            return (
              <code key={i} className="px-1 py-0.5 rounded"
                style={{ background: 'var(--card)', color: 'var(--amber)', fontSize: '12px' }}>
                {p.slice(1, -1)}
              </code>
            )
          }
          const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)
          if (linkMatch) {
            return (
              <a key={i} href={linkMatch[2]} target="_blank" rel="noreferrer"
                style={{ color: 'var(--primary)' }} className="hover:underline">
                {linkMatch[1]}
              </a>
            )
          }
          return p
        })}
      </span>
    )
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('```')) {
      if (inCode) {
        result.push(<InlineCodeBlock key={key()} code={codeLines.join('\n')} lang={codeLang} />)
        codeLines = []; inCode = false; codeLang = ''
      } else {
        inCode = true; codeLang = line.slice(3).trim()
      }
      continue
    }
    if (inCode) { codeLines.push(line); continue }

    if (line.startsWith('# ')) {
      result.push(<h1 key={key()} className="font-semibold mb-2 mt-4" style={{ color: 'var(--foreground)', fontSize: '16px' }}>{renderInline(line.slice(2), key())}</h1>)
    } else if (line.startsWith('## ')) {
      result.push(<h2 key={key()} className="font-semibold mb-1.5 mt-3" style={{ color: 'var(--foreground)', fontSize: '14px' }}>{renderInline(line.slice(3), key())}</h2>)
    } else if (line.startsWith('### ')) {
      result.push(<h3 key={key()} className="font-medium mb-1 mt-2" style={{ color: 'var(--secondary-foreground)', fontSize: '13px' }}>{renderInline(line.slice(4), key())}</h3>)
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      result.push(
        <div key={key()} className="flex gap-2 mb-1 ml-1">
          <span className="mt-0.5 shrink-0" style={{ color: 'var(--border-strong)', fontSize: '11px' }}>•</span>
          <span style={{ color: 'var(--muted-foreground)', fontSize: '13px', lineHeight: '1.65' }}>{renderInline(line.slice(2), key())}</span>
        </div>
      )
    } else if (/^\d+\. /.test(line)) {
      const [num, ...rest] = line.split('. ')
      result.push(
        <div key={key()} className="flex gap-2 mb-1 ml-1">
          <span className="shrink-0" style={{ color: 'var(--border-strong)', fontSize: '12px' }}>{num}.</span>
          <span style={{ color: 'var(--muted-foreground)', fontSize: '13px', lineHeight: '1.65' }}>{renderInline(rest.join('. '), key())}</span>
        </div>
      )
    } else if (line.startsWith('---') || line.startsWith('***')) {
      result.push(<hr key={key()} className="my-3" style={{ borderColor: 'var(--border)' }} />)
    } else if (line.trim() === '') {
      result.push(<div key={key()} className="h-2" />)
    } else {
      result.push(
        <p key={key()} className="mb-1" style={{ color: 'var(--muted-foreground)', fontSize: '13px', lineHeight: '1.7' }}>
          {renderInline(line, key())}
        </p>
      )
    }
  }

  if (inCode && codeLines.length > 0) {
    result.push(<InlineCodeBlock key={key()} code={codeLines.join('\n')} lang={codeLang} />)
  }

  return <>{result}</>
}

function InlineCodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="my-3 rounded-lg overflow-hidden" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
      {lang && (
        <div className="flex items-center justify-between px-3 py-1.5" style={{ background: 'var(--sidebar)', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--border-strong)', fontSize: '10px' }}>{lang}</span>
          <button
            onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
            className="flex items-center gap-1 transition-colors"
            style={{ color: 'var(--border-strong)', fontSize: '10px' }}
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <pre className="px-4 py-3 overflow-x-auto" style={{ fontSize: '12px', lineHeight: '1.65', scrollbarWidth: 'thin' }}>
        <code style={{ color: 'var(--secondary-foreground)' }}>{code}</code>
      </pre>
    </div>
  )
}

/* ─── Block renderers ─── */

function TextBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <span>
      <MarkdownErrorBoundary rawText={content}>
        <MarkdownContent content={content} />
      </MarkdownErrorBoundary>
      {streaming && (
        <span
          aria-hidden
          className="inline-block align-middle ml-0.5"
          style={{
            width: '2px',
            height: '14px',
            background: 'var(--border-strong)',
            animation: 'wos-blink 1s steps(2, start) infinite',
            verticalAlign: '-2px',
          }}
        />
      )}
    </span>
  )
}

function ReasoningBlock({ content, collapsed: initCollapsed, done, autoCollapse, interrupted }: {
  content: string; collapsed?: boolean; done?: boolean; autoCollapse?: boolean; interrupted?: boolean
}) {
  const streaming = !done
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const baseCollapsed = streaming ? false : ((initCollapsed ?? true) || !!autoCollapse)
  const effectiveCollapsed = userToggled ?? baseCollapsed
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <button
        onClick={() => setUserToggled(o => !(o ?? effectiveCollapsed))}
        className="flex items-center gap-2 px-3 py-2 w-full text-left wos-hover-sm transition-colors"
      >
        <Brain
          size={12}
          style={{ color: interrupted ? 'var(--amber)' : (streaming ? 'var(--amber)' : 'var(--muted-foreground)') }}
          className={streaming && !interrupted ? 'animate-pulse' : ''}
        />
        <span className="text-xs flex-1" style={{ color: interrupted ? 'var(--amber)' : (streaming ? 'var(--secondary-foreground)' : 'var(--muted-foreground)') }}>
          {interrupted ? 'Thought (interrupted)' : (streaming ? 'Thinking…' : 'Thought')}
        </span>
        {effectiveCollapsed
          ? <ChevronRight size={10} style={{ color: 'var(--border-strong)' }} />
          : <ChevronDown size={10} style={{ color: 'var(--border-strong)' }} />}
      </button>
      {!effectiveCollapsed && (
        <div className="px-3 pb-3 pt-2.5 text-xs leading-relaxed whitespace-pre-wrap"
          style={{ color: 'var(--muted-foreground)', borderTop: '1px solid var(--border)' }}>
          {content}
          {interrupted && (
            <span className="block mt-2 italic" style={{ color: 'var(--amber)' }}>
              … reasoning was cut off when the previous run ended.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ToolUseBlock({
  toolName, toolId: _toolId, input, partialArgs, status, result, error, stdout, stderr, interrupted,
  autoCollapse,
}: Extract<MessageBlock, { type: 'tool_use' }> & { autoCollapse?: boolean }) {
  const isPreparing = status === 'preparing'
  const isRunning = status === 'running'
  const isComplete = status === 'done' || status === 'error' || !!interrupted
  // Mirror ReasoningBlock: keep open while in-flight, auto-collapse when done
  // unless this is the most recent block. User toggle always wins.
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const baseCollapsed = isComplete ? !!autoCollapse : !(isPreparing || isRunning)
  const expanded = userToggled !== null ? !userToggled : !baseCollapsed
  const statusIcon = interrupted
    ? <AlertCircle size={11} className="text-zinc-400" />
    : status === 'preparing'
    ? <Loader2 size={11} className="animate-spin text-zinc-400" />
    : status === 'running'
    ? <Loader2 size={11} className="animate-spin text-blue-400" />
    : status === 'error'
    ? <X size={11} className="text-red-400" />
    : <Check size={11} className="text-green-400" />

  const statusLabel = interrupted
    ? 'interrupted'
    : status === 'preparing'
    ? 'preparing…'
    : status === 'running'
    ? 'running…'
    : status === 'error'
    ? 'failed'
    : 'done'

  const hasInput = input != null && typeof input === 'object' && Object.keys(input as Record<string, unknown>).length > 0
  const showPartial = isPreparing && partialArgs

  const editDiff = useMemo(() => {
    if (!input || typeof input !== 'object') return null
    const i = input as Record<string, unknown>
    if (typeof i.old_string === 'string' && typeof i.new_string === 'string') {
      return { path: typeof i.file_path === 'string' ? i.file_path : '', old: i.old_string as string, next: i.new_string as string }
    }
    return null
  }, [input])

  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <button
        onClick={() => setUserToggled(prev => prev === null ? !expanded : !prev)}
        className="flex items-center gap-2 px-3 py-1.5 w-full text-left wos-hover-sm transition-colors"
      >
        {statusIcon}
        <span className="text-xs font-mono" style={{ color: 'var(--secondary-foreground)' }}>{toolName}</span>
        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{statusLabel}</span>
        <ChevronRight
          size={10}
          className={cn('ml-auto transition-transform', expanded && 'rotate-90')}
          style={{ color: 'var(--border-strong)' }}
        />
      </button>
      {expanded && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border)' }}>
          {showPartial ? (
            <>
              <div className="text-[10px] mb-1" style={{ color: 'var(--muted-foreground)' }}>Input (streaming)</div>
              <pre className="text-xs p-2 rounded overflow-x-auto max-h-48" style={{ fontSize: '11px', background: 'var(--background)', color: 'var(--secondary-foreground)' }}>
                {partialArgs}
                <span className="inline-block w-0.5 h-3 bg-zinc-400/60 animate-pulse ml-0.5 align-middle" />
              </pre>
            </>
          ) : hasInput ? (
            <>
              {editDiff ? (
                <>
                  {editDiff.path && <div className="text-[10px] text-blue-300 font-mono mb-1">{editDiff.path}</div>}
                  <div className="text-[10px] mb-1" style={{ color: 'var(--muted-foreground)' }}>Diff</div>
                  <pre className="text-xs p-2 rounded overflow-x-auto max-h-64" style={{ fontSize: '11px', background: 'var(--background)' }}>
                    {editDiff.old.split('\n').map((line, i) => (
                      <div key={`o-${i}`} className="text-red-300/90">{'- ' + line}</div>
                    ))}
                    {editDiff.next.split('\n').map((line, i) => (
                      <div key={`n-${i}`} className="text-green-300/90">{'+ ' + line}</div>
                    ))}
                  </pre>
                </>
              ) : (
                <>
                  <div className="text-[10px] mb-1" style={{ color: 'var(--muted-foreground)' }}>Input</div>
                  <pre className="text-xs p-2 rounded overflow-x-auto max-h-48" style={{ fontSize: '11px', background: 'var(--background)', color: 'var(--secondary-foreground)' }}>
                    {JSON.stringify(input, null, 2)}
                  </pre>
                </>
              )}
            </>
          ) : null}
          {(stdout || stderr) && (
            <>
              <div className="text-[10px] mb-1 mt-2" style={{ color: 'var(--muted-foreground)' }}>Output (live)</div>
              <pre className="text-xs p-2 rounded overflow-x-auto max-h-64" style={{ fontSize: '11px', background: 'var(--background)' }}>
                {stdout && <span style={{ color: 'var(--secondary-foreground)' }}>{stdout}</span>}
                {stderr && <span className="text-red-400">{stderr}</span>}
                {status !== 'done' && status !== 'error' && (
                  <span className="inline-block w-0.5 h-3 bg-blue-400/60 animate-pulse ml-0.5 align-middle" />
                )}
              </pre>
            </>
          )}
          {result !== undefined && result !== null && (
            <>
              <div className="text-[10px] mb-1 mt-2" style={{ color: 'var(--muted-foreground)' }}>Result</div>
              <pre className="text-xs p-2 rounded overflow-x-auto max-h-64" style={{ fontSize: '11px', background: 'var(--background)', color: 'var(--secondary-foreground)' }}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </>
          )}
          {error && (
            <div className="text-xs text-red-400 mt-1">{error}</div>
          )}
        </div>
      )}
    </div>
  )
}

function PermissionBlock({
  toolName, toolId, args, decision,
}: Extract<MessageBlock, { type: 'permission_request' }>) {
  const { grantPermission, denyPermission } = useAgentStore()

  if (decision) {
    return (
      <div
        className={cn(
          'border-l-2 pl-3 my-1 py-1 opacity-60',
          decision === 'allowed' ? 'border-green-600' : 'border-red-600'
        )}
      >
        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          {decision === 'allowed' ? '✓' : '✗'} {toolName} — {decision}
        </span>
      </div>
    )
  }

  return (
    <div className="my-2 rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border)', borderLeft: '2px solid var(--amber)', background: 'var(--card)' }}>
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-2">
          <AlertCircle size={12} style={{ color: 'var(--amber)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--amber)' }}>Action Required</span>
        </div>
        <div className="text-xs mb-2" style={{ color: 'var(--muted-foreground)' }}>
          Tool: <code className="font-mono px-1 py-0.5 rounded" style={{ color: 'var(--secondary-foreground)', background: 'var(--background)' }}>{toolName}</code>
        </div>
        {args != null && (
          <pre className="text-xs p-2 rounded mb-3 overflow-y-auto max-h-24"
            style={{ fontSize: '11px', color: 'var(--muted-foreground)', background: 'var(--background)', border: '1px solid var(--border)' }}>
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => grantPermission(toolId, 'allow')}
            className="text-xs px-3 py-1 rounded transition-colors font-medium"
            style={{ background: 'var(--amber)', color: '#000' }}
          >
            Allow
          </button>
          <button
            onClick={() => grantPermission(toolId, 'allow-session')}
            className="text-xs px-3 py-1 rounded transition-colors"
            style={{ border: '1px solid var(--border)', color: 'var(--secondary-foreground)' }}
          >
            Allow All Session
          </button>
          <button
            onClick={() => denyPermission(toolId)}
            className="text-xs px-3 py-1 rounded transition-colors"
            style={{ border: '1px solid rgba(239,68,68,0.4)', color: '#f87171' }}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}

function PlanApprovalBlock({
  question, questionId, answer, interrupted,
}: Extract<MessageBlock, { type: 'ask_user' }>) {
  const { answerQuestion, setMode } = useAgentStore()
  const activeWorkspace = useWorkspaceStore(s => s.activeWorkspace)
  const [showPlan, setShowPlan] = useState(true)
  const [showSuggest, setShowSuggest] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)

  // Plan markdown is encoded as: `__plan_approval__\n\n<markdown>`
  const planMarkdown = useMemo(() => {
    const sep = '__plan_approval__\n\n'
    return question.startsWith(sep) ? question.slice(sep.length) : ''
  }, [question])

  if (answer !== undefined) {
    const cancelled = answer === '__cancelled__' || interrupted
    let label = '✓ Plan handled'
    if (cancelled) label = '⚠ Plan approval cancelled'
    else if (answer === 'approve' || answer === 'approve_default') label = '✓ Plan approved (default mode)'
    else if (answer === 'approve_yolo') label = '✓ Plan approved (YOLO mode)'
    else if (answer === 'save' || answer.startsWith('save')) label = '💾 Plan saved — run ended'
    else if (answer.startsWith('suggest:') || answer === 'reject') label = '✏ Suggested changes — agent revising'

    return (
      <div
        className={cn(
          'border-l-2 pl-3 my-2 py-1 opacity-70',
          cancelled ? 'border-zinc-600/50' : 'border-green-500/50'
        )}
      >
        <span className="text-xs" style={{ color: cancelled ? 'var(--amber)' : 'var(--secondary-foreground)' }}>
          {label}
        </span>
      </div>
    )
  }

  const submitDecision = async (decision: string) => {
    await answerQuestion(questionId, decision)
  }

  const handleApproveYolo = async () => {
    try { await setMode('yolo') } catch { /* ignore */ }
    void submitDecision('approve_yolo')
  }

  const handleApproveDefault = async () => {
    void submitDecision('approve_default')
  }

  const handleSavePlan = async () => {
    if (!activeWorkspace || !planMarkdown.trim()) {
      void submitDecision('save')
      return
    }
    setSaving(true)
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const relPath = `wos-plans/plan-${ts}.md`
      const result = await window.wos.saveWorkspaceFile({
        workspaceId: activeWorkspace.id,
        relPath,
        content: planMarkdown,
      })
      if (!result.ok) {
        toast.error(`Could not save plan: ${result.error ?? 'unknown error'}`)
      } else {
        toast.success(`Plan saved to ${relPath}`)
      }
    } catch (err) {
      toast.error(`Could not save plan: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
      void submitDecision('save')
    }
  }

  const handleSubmitSuggest = () => {
    const text = feedback.trim()
    if (!text) return
    void submitDecision(`suggest:${text}`)
  }

  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-subtle)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--amber)' }}>📋</span>
        <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Plan ready — choose how to proceed</span>
        {planMarkdown && (
          <button
            onClick={() => setShowPlan(v => !v)}
            className="ml-auto text-xs px-2 py-0.5 rounded transition-colors"
            style={{ color: 'var(--muted-foreground)' }}
          >
            {showPlan ? 'Hide plan ▲' : 'Show plan ▼'}
          </button>
        )}
      </div>

      {showPlan && planMarkdown && (
        <div
          className="px-3 py-2 text-sm"
          style={{
            background: 'var(--card)',
            borderBottom: '1px solid var(--border)',
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          <MarkdownErrorBoundary rawText={planMarkdown}>
            <MarkdownContent content={planMarkdown} />
          </MarkdownErrorBoundary>
        </div>
      )}

      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        <button
          onClick={handleApproveYolo}
          className="text-left text-sm px-3 py-2 rounded transition-colors hover:opacity-90"
          style={{ background: 'var(--surface-raised)', color: 'var(--foreground)', border: '1px solid var(--border-strong)' }}
        >
          ▶ Start in YOLO <span style={{ opacity: 0.7, fontSize: 11 }}>— auto-approve every tool</span>
        </button>
        <button
          onClick={handleApproveDefault}
          className="text-left text-sm px-3 py-2 rounded transition-colors hover:opacity-90"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)', border: '1px solid var(--border)' }}
        >
          ▶ Start with Default <span style={{ opacity: 0.7, fontSize: 11 }}>— ask before risky tools</span>
        </button>
        <button
          onClick={handleSavePlan}
          disabled={saving}
          className="text-left text-sm px-3 py-2 rounded transition-colors hover:opacity-90 disabled:opacity-50"
          style={{ background: 'var(--card)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' }}
        >
          💾 {saving ? 'Saving…' : 'Save plan & exit'} <span style={{ opacity: 0.7, fontSize: 11 }}>— I&apos;ll do it myself</span>
        </button>
        {!showSuggest ? (
          <button
            onClick={() => setShowSuggest(true)}
            className="text-left text-sm px-3 py-2 rounded transition-colors hover:opacity-90"
            style={{ background: 'var(--card)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' }}
          >
            ✏ Suggest changes <span style={{ opacity: 0.7, fontSize: 11 }}>— give feedback, agent revises</span>
          </button>
        ) : (
          <div className="rounded p-2" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="What should change in the plan?"
              rows={3}
              className="w-full text-sm px-2 py-1.5 rounded resize-y outline-none"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              autoFocus
            />
            <div className="flex gap-2 mt-2 justify-end">
              <button
                onClick={() => { setShowSuggest(false); setFeedback('') }}
                className="text-xs px-3 py-1 rounded transition-colors"
                style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitSuggest}
                disabled={!feedback.trim()}
                className="text-xs px-3 py-1 rounded transition-colors disabled:opacity-50"
                style={{ background: 'var(--amber)', color: 'var(--background)', border: '1px solid var(--amber)' }}
              >
                Send feedback
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AskUserConfirmBlock({
  question, questionId,
}: {
  question: string; questionId: string
}) {
  const { answerQuestion } = useAgentStore()
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <HelpCircle size={12} style={{ color: 'var(--amber)' }} />
        <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Confirm</span>
      </div>
      <div className="px-3 py-2.5">
        <div className="text-sm mb-3" style={{ color: 'var(--secondary-foreground)' }}>{question}</div>
        <div className="flex gap-2">
          <button
            onClick={() => answerQuestion(questionId, 'yes')}
            className="text-xs px-4 py-1.5 rounded-lg font-medium"
            style={{ background: 'var(--amber)', color: '#000' }}
          >
            Yes
          </button>
          <button
            onClick={() => answerQuestion(questionId, 'no')}
            className="text-xs px-4 py-1.5 rounded-lg wos-hover"
            style={{ border: '1px solid var(--border)', color: 'var(--secondary-foreground)' }}
          >
            No
          </button>
        </div>
      </div>
    </div>
  )
}

function AskUserFileDropBlock({
  question, questionId, accept,
}: {
  question: string; questionId: string; accept?: string[]
}) {
  const { answerQuestion } = useAgentStore()
  const [hover, setHover] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files)
    const summaries = await Promise.all(
      arr.map(async f => ({
        name: f.name,
        size: f.size,
        type: f.type,
        path: ((f as unknown) as { path?: string }).path ?? '',
      }))
    )
    void answerQuestion(questionId, JSON.stringify(summaries))
  }, [answerQuestion, questionId])

  const acceptStr = accept?.join(',')

  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <HelpCircle size={12} style={{ color: 'var(--amber)' }} />
        <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Drop files</span>
      </div>
      <div className="px-3 py-2.5">
        <div className="text-sm mb-3" style={{ color: 'var(--secondary-foreground)' }}>{question}</div>
        <div
          onDragOver={e => { e.preventDefault(); setHover(true) }}
          onDragLeave={() => setHover(false)}
          onDrop={e => {
            e.preventDefault(); setHover(false)
            if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files)
          }}
          onClick={() => inputRef.current?.click()}
          className="rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 py-6 cursor-pointer transition-colors"
          style={{
            borderColor: hover ? 'var(--amber)' : 'var(--border)',
            background: hover ? 'rgba(245,158,11,0.05)' : 'var(--background)',
            color: 'var(--secondary-foreground)',
          }}
        >
          <span className="text-xs">Drop files here or click to browse</span>
          {accept && accept.length > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--border-strong)' }}>Accepts: {accept.join(', ')}</span>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={acceptStr}
          className="hidden"
          onChange={e => { if (e.target.files) void handleFiles(e.target.files) }}
        />
      </div>
    </div>
  )
}

function AskUserFormBlock({
  question, questionId, fields,
}: {
  question: string; questionId: string; fields: import('../../../types').AskUserFormField[]
}) {
  const { answerQuestion } = useAgentStore()
  const [vals, setVals] = useState<Record<string, string | boolean | number>>({})
  const submit = () => {
    const missing = fields.filter(f => f.required && (vals[f.key] === undefined || vals[f.key] === ''))
    if (missing.length) return
    void answerQuestion(questionId, JSON.stringify(vals))
  }
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <HelpCircle size={12} style={{ color: 'var(--amber)' }} />
        <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Form</span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        <div className="text-sm mb-1" style={{ color: 'var(--secondary-foreground)' }}>{question}</div>
        {fields.map(f => (
          <div key={f.key} className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {f.label}{f.required ? ' *' : ''}
            </label>
            {f.type === 'textarea' ? (
              <textarea
                placeholder={f.placeholder}
                value={(vals[f.key] as string) ?? ''}
                onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))}
                className="text-sm rounded-lg px-3 py-1.5 outline-none min-h-[60px]"
                style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            ) : f.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={Boolean(vals[f.key])}
                onChange={e => setVals(v => ({ ...v, [f.key]: e.target.checked }))}
              />
            ) : (
              <input
                type={f.type === 'number' ? 'number' : 'text'}
                placeholder={f.placeholder}
                value={(vals[f.key] as string) ?? ''}
                onChange={e => setVals(v => ({ ...v, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value }))}
                className="text-sm rounded-lg px-3 py-1.5 outline-none"
                style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            )}
          </div>
        ))}
        <button
          onClick={submit}
          className="text-xs px-3 py-1.5 rounded-lg font-medium mt-2"
          style={{ background: 'var(--amber)', color: '#000' }}
        >
          Submit
        </button>
      </div>
    </div>
  )
}

function AskUserBlock({
  question, questionId, choices, answer, interrupted, extras,
}: Extract<MessageBlock, { type: 'ask_user' }>) {
  const [localAnswer, setLocalAnswer] = useState('')
  const { answerQuestion } = useAgentStore()

  if (answer !== undefined) {
    const cancelled = answer === '__cancelled__' || interrupted
    return (
      <div className="rounded-lg px-3 py-2 my-2 opacity-60" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
        <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>❓ {question}</div>
        <div className="text-sm mt-0.5" style={{ color: cancelled ? 'var(--amber)' : 'var(--secondary-foreground)' }}>
          {cancelled ? '⚠ cancelled — previous run did not finish' : `→ ${answer.length > 200 ? answer.slice(0, 200) + '…' : answer}`}
        </div>
      </div>
    )
  }

  const kind = extras?.kind ?? (choices && choices.length > 0 ? 'choice' : 'text')

  if (kind === 'confirm') {
    return <AskUserConfirmBlock question={question} questionId={questionId} />
  }
  if (kind === 'fileDrop') {
    return <AskUserFileDropBlock question={question} questionId={questionId} accept={extras?.accept} />
  }
  if (kind === 'form' && extras?.fields && extras.fields.length > 0) {
    return <AskUserFormBlock question={question} questionId={questionId} fields={extras.fields} />
  }
  // 'picker' falls through to text+choices for now (fed by the agent into `choices`).
  // 'text' and 'choice' share the original UI.
  const allowFreeform = extras?.allowFreeform !== false

  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <HelpCircle size={12} style={{ color: 'var(--amber)' }} />
        <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Question</span>
      </div>
      <div className="px-3 py-2.5">
        <div className="text-sm mb-3" style={{ color: 'var(--secondary-foreground)' }}>{question}</div>
        {choices && choices.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {choices.map(c => (
              <button
                key={c}
                onClick={() => answerQuestion(questionId, c)}
                className="text-xs px-3 py-1.5 rounded-lg transition-colors wos-hover"
                style={{ border: '1px solid var(--border)', color: 'var(--secondary-foreground)' }}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        {choices && choices.length > 0 && allowFreeform && (
          <div className="flex items-center gap-2 mb-2.5">
            <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
            <span className="text-[10px]" style={{ color: 'var(--border-strong)' }}>or type your answer</span>
            <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
          </div>
        )}
        {(allowFreeform || !choices || choices.length === 0) && (
          <div className="flex gap-2">
            <input
              value={localAnswer}
              onChange={e => setLocalAnswer(e.target.value)}
              placeholder="Type your answer…"
              className="flex-1 text-sm rounded-lg px-3 py-1.5 outline-none"
              style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              onKeyDown={e => {
                if (e.key === 'Enter' && localAnswer.trim()) {
                  answerQuestion(questionId, localAnswer.trim())
                }
              }}
            />
            <button
              onClick={() => { if (localAnswer.trim()) answerQuestion(questionId, localAnswer.trim()) }}
              disabled={!localAnswer.trim()}
              className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors font-medium"
              style={{ background: 'var(--amber)', color: '#000' }}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Subagent inline rendering ─── */

/** 7-color palette indexed by colorSeed (0-6). Works in dark & light themes. */
const AGENT_PALETTE = [
  { bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.35)',  text: '#60a5fa' },  // blue
  { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.35)',  text: '#34d399' },  // emerald
  { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)',  text: '#fbbf24' },  // amber
  { bg: 'rgba(244,63,94,0.12)',  border: 'rgba(244,63,94,0.35)',   text: '#fb7185' },  // rose
  { bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.35)',  text: '#a78bfa' },  // violet
  { bg: 'rgba(6,182,212,0.12)',  border: 'rgba(6,182,212,0.35)',   text: '#22d3ee' },  // cyan
  { bg: 'rgba(217,70,239,0.12)', border: 'rgba(217,70,239,0.35)',  text: '#e879f9' },  // fuchsia
] as const

export function getAgentColor(colorSeed?: number) {
  return AGENT_PALETTE[(colorSeed ?? 0) % AGENT_PALETTE.length]
}

/** Elapsed-time hook: updates every second while running. */
function useElapsed(startedAt?: number, isRunning?: boolean) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!startedAt || !isRunning) { setElapsed(0); return }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [startedAt, isRunning])
  return elapsed
}

function formatElapsed(secs: number) {
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${secs % 60}s`
}

/** Renders a single subagent event line (preserves all existing event kinds). */
function SubagentEventLine({ event, color }: { event: AgentEvent; color: { text: string } }) {
  if (event.type === 'text_delta') {
    return <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>{event.content}</p>
  }
  if (event.type === 'reasoning_delta') {
    return <p className="text-[10px] italic whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)', opacity: 0.65 }}>{event.content}</p>
  }
  if (event.type === 'tool_use_start') {
    return (
      <p className="text-[10px] flex items-center gap-1" style={{ color: color.text }}>
        <Loader2 size={9} className="animate-spin" />
        Tool: {event.toolName}
      </p>
    )
  }
  if (event.type === 'tool_stdout_delta') {
    return (
      <pre className="text-[10px] px-2 py-0.5 rounded overflow-x-auto whitespace-pre-wrap"
        style={{ background: 'var(--background)', color: 'var(--secondary-foreground)' }}>
        {event.delta}
      </pre>
    )
  }
  if (event.type === 'tool_stderr_delta') {
    return (
      <pre className="text-[10px] px-2 py-0.5 rounded overflow-x-auto whitespace-pre-wrap"
        style={{ background: 'var(--background)', color: '#f87171' }}>
        {event.delta}
      </pre>
    )
  }
  if (event.type === 'tool_result') {
    return (
      <p className="text-[10px]" style={{ color: event.error ? '#f87171' : 'var(--border-strong)' }}>
        {event.error ? `Tool failed: ${event.error}` : '✓ Tool completed'}
      </p>
    )
  }
  if (event.type === 'error') {
    return <p className="text-[10px] text-red-400">{event.message}</p>
  }
  if (event.type === 'turn_complete') {
    return <p className="text-[10px]" style={{ color: 'var(--border-strong)' }}>Turn complete</p>
  }
  return null
}

/** Collapses consecutive events of the same kind into merged groups for display. */
function mergeEvents(events: AgentEvent[]) {
  type MergedEvent =
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'stdout'; text: string }
    | { kind: 'stderr'; text: string }
    | { kind: 'other'; event: AgentEvent }

  const groups: MergedEvent[] = []
  for (const e of events) {
    const last = groups[groups.length - 1]
    if (e.type === 'text_delta') {
      if (last?.kind === 'text') { last.text += e.content; continue }
      groups.push({ kind: 'text', text: e.content })
    } else if (e.type === 'reasoning_delta') {
      if (last?.kind === 'reasoning') { last.text += e.content; continue }
      groups.push({ kind: 'reasoning', text: e.content })
    } else if (e.type === 'tool_stdout_delta') {
      if (last?.kind === 'stdout') { last.text += e.delta; continue }
      groups.push({ kind: 'stdout', text: e.delta })
    } else if (e.type === 'tool_stderr_delta') {
      if (last?.kind === 'stderr') { last.text += e.delta; continue }
      groups.push({ kind: 'stderr', text: e.delta })
    } else {
      groups.push({ kind: 'other', event: e })
    }
  }
  return groups
}

/** Renders a merged event group inline. */
function MergedEventLine({ group, color }: {
  group: ReturnType<typeof mergeEvents>[number]
  color: { text: string }
}) {
  if (group.kind === 'text') {
    return <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>{group.text}</p>
  }
  if (group.kind === 'reasoning') {
    return <p className="text-[10px] italic whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)', opacity: 0.65 }}>{group.text}</p>
  }
  if (group.kind === 'stdout') {
    return (
      <pre className="text-[10px] px-2 py-0.5 rounded overflow-x-auto whitespace-pre-wrap"
        style={{ background: 'var(--background)', color: 'var(--secondary-foreground)' }}>
        {group.text}
      </pre>
    )
  }
  if (group.kind === 'stderr') {
    return (
      <pre className="text-[10px] px-2 py-0.5 rounded overflow-x-auto whitespace-pre-wrap"
        style={{ background: 'var(--background)', color: '#f87171' }}>
        {group.text}
      </pre>
    )
  }
  return <SubagentEventLine event={group.event} color={color} />
}

/**
 * Per-run collapsible header + inline event list.
 * `expanded` / `onToggle` / `onFocus` come from the parent.
 */
function SubagentRunHeader({
  agentId, prompt, agentName, colorSeed, startedAt, result, interrupted, expanded, onToggle, onFocus,
}: {
  agentId: string
  prompt: string
  agentName?: string
  colorSeed?: number
  startedAt?: number
  result?: string
  interrupted?: boolean
  expanded: boolean
  onToggle: () => void
  onFocus: () => void
}) {
  const color = getAgentColor(colorSeed)
  const isRunning = result === undefined && !interrupted
  const elapsed = useElapsed(startedAt, isRunning)
  const shortId = agentId.slice(0, 6)
  const displayName = agentName ?? 'task'

  let statusLabel = 'running'
  let statusColor: string = color.text
  if (interrupted || result === '[interrupted]') { statusLabel = 'cancelled'; statusColor = '#94a3b8' }
  else if (result !== undefined) { statusLabel = 'done'; statusColor = '#4ade80' }

  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg wos-hover-sm transition-colors mt-2"
      style={{ border: `1px solid ${color.border}`, background: color.bg }}
      aria-expanded={expanded}
    >
      <ChevronRight size={10} className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} style={{ color: color.text }} />
      <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-medium shrink-0" style={{ background: color.bg, border: `1px solid ${color.border}`, color: color.text }}>
        🤖 {displayName}#{shortId}
      </span>
      <span
        className="text-[10px] truncate flex-1 text-left"
        style={{ color: 'var(--muted-foreground)' }}
        onClick={e => { e.stopPropagation(); onFocus() }}
        title="Click to focus this agent"
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onFocus() } }}
      >
        {prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt}
      </span>
      <span className="text-[10px] shrink-0 font-medium px-1.5 py-0.5 rounded-full" style={{ color: statusColor, background: 'rgba(0,0,0,0.2)' }}>
        {statusLabel}
      </span>
      {isRunning && (
        <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
          {formatElapsed(elapsed)}
        </span>
      )}
    </button>
  )
}

function SubagentBlock({
  agentId, prompt, events, result, interrupted, agentName, colorSeed, startedAt,
  expanded, onToggle, onFocus,
}: Extract<MessageBlock, { type: 'subagent' }> & {
  expanded: boolean
  onToggle: () => void
  onFocus: () => void
}) {
  const color = getAgentColor(colorSeed)
  const isRunning = result === undefined && !interrupted
  const merged = useMemo(() => mergeEvents(events), [events])

  // Live-tail: latest event text shown next to header when collapsed
  const latestPreview = useMemo(() => {
    for (let i = merged.length - 1; i >= 0; i--) {
      const g = merged[i]
      if (g.kind === 'text' && g.text.trim()) return g.text.slice(0, 80)
      if (g.kind === 'reasoning' && g.text.trim()) return g.text.slice(0, 80)
    }
    return null
  }, [merged])

  return (
    <div className="my-1">
      <SubagentRunHeader
        agentId={agentId}
        prompt={prompt}
        agentName={agentName}
        colorSeed={colorSeed}
        startedAt={startedAt}
        result={result}
        interrupted={interrupted}
        expanded={expanded}
        onToggle={onToggle}
        onFocus={onFocus}
      />

      {/* Live tail when collapsed */}
      {!expanded && isRunning && latestPreview && (
        <div className="flex items-center gap-2 px-3 mt-1">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse" style={{ background: color.text }} />
          <span className="text-[10px] truncate" style={{ color: 'var(--muted-foreground)' }}>{latestPreview}</span>
        </div>
      )}

      {/* Expanded event list (no truncation) */}
      {expanded && merged.length > 0 && (
        <div className="mt-1 ml-3 pl-3 space-y-0.5 py-1" style={{ borderLeft: `2px solid ${color.border}` }}>
          {merged.map((g, i) => (
            <MergedEventLine key={i} group={g} color={color} />
          ))}
        </div>
      )}

      {/* Result row */}
      {result && result !== '[interrupted]' && expanded && (
        <div className="mt-1 ml-3 pl-3 py-1" style={{ borderLeft: `2px solid ${color.border}` }}>
          <p className="text-xs" style={{ color: 'var(--secondary-foreground)' }}>
            ✓ {result.slice(0, 300)}{result.length > 300 ? '…' : ''}
          </p>
        </div>
      )}
    </div>
  )
}

function ErrorBlock({ message, retryable }: Extract<MessageBlock, { type: 'error' }>) {
  const { retryLastMessage } = useAgentStore()
  return (
    <div className="my-2 rounded-lg p-3" style={{ border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)' }}>
      <div className="flex items-center gap-2 mb-1" style={{ color: '#f87171' }}>
        <AlertCircle size={13} />
        <span className="text-sm font-medium">Error</span>
      </div>
      <div className="text-xs" style={{ color: 'rgba(248,113,113,0.8)' }}>{message}</div>
      {retryable && (
        <button
          onClick={retryLastMessage}
          className="mt-2 text-xs px-3 py-1 rounded transition-colors flex items-center gap-1.5"
          style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}
        >
          <RefreshCw size={10} /> Retry
        </button>
      )}
    </div>
  )
}

function CompactNoticeBlock({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-3 rounded-lg p-3" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
        <RefreshCw size={11} />
        <span>Context compacted</span>
        <button onClick={() => setExpanded(o => !o)} className="ml-auto underline text-xs" style={{ color: 'var(--border-strong)' }}>
          {expanded ? 'Hide' : 'Show'} summary
        </button>
      </div>
      {expanded && (
        <div className="mt-2 text-xs p-2 rounded" style={{ color: 'var(--muted-foreground)', background: 'var(--background)' }}>
          {summary}
        </div>
      )}
    </div>
  )
}

function DiffBlock({ filePath, diff, collapsed: initCollapsed }: Extract<MessageBlock, { type: 'diff' }>) {
  const [collapsed, setCollapsed] = useState(initCollapsed ?? true)
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      <button
        onClick={() => setCollapsed(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 w-full text-left wos-hover-sm transition-colors"
      >
        <FileEdit size={11} className="text-blue-400" />
        <span className="text-xs font-mono text-blue-400 flex-1 truncate">{filePath}</span>
        <span className="text-[10px]" style={{ color: 'var(--border-strong)' }}>{collapsed ? 'Show diff ▼' : 'Hide ▲'}</span>
      </button>
      {!collapsed && (
        <pre
          className="px-3 py-2 overflow-x-auto text-xs"
          style={{ fontSize: '11px', lineHeight: '1.5', background: 'var(--background)', borderTop: '1px solid var(--border)' }}
        >
          {diff.split('\n').map((line, i) => (
            <div
              key={i}
              style={{
                color: line.startsWith('+') ? '#4ade80' : line.startsWith('-') ? '#f87171' : 'var(--muted-foreground)',
                background: line.startsWith('+') ? 'rgba(74,222,128,0.05)' : line.startsWith('-') ? 'rgba(248,113,113,0.05)' : 'transparent',
              }}
            >
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

/* ─── TodoWrite block ─── */
interface TodoItem { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }
function TodoBlock({
  input, partialArgs, result,
}: Extract<MessageBlock, { type: 'tool_use' }>) {
  let todos: TodoItem[] = []
  const src =
    (result && typeof result === 'object' && 'todos' in (result as Record<string, unknown>))
      ? (result as { todos: TodoItem[] }).todos
      : (input && typeof input === 'object' && 'todos' in (input as Record<string, unknown>))
      ? ((input as { todos: TodoItem[] }).todos)
      : null
  if (Array.isArray(src)) todos = src
  else if (partialArgs) {
    try {
      const parsed = JSON.parse(partialArgs) as { todos?: TodoItem[] }
      if (parsed.todos) todos = parsed.todos
    } catch { /* partial JSON, ignore */ }
  }

  const done = todos.filter(t => t.status === 'completed').length
  const running = todos.find(t => t.status === 'in_progress')

  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-mono text-[#a78bfa]">todos</span>
        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{done}/{todos.length} done{running ? ` · ${running.content}` : ''}</span>
      </div>
      {todos.length > 0 && (
        <ul className="px-3 py-2 space-y-1" style={{ borderTop: '1px solid var(--border)' }}>
          {todos.map(t => (
            <li key={t.id} className="flex items-start gap-2 text-xs">
              <span
                aria-hidden
                className={cn(
                  'mt-[3px] inline-block w-3 h-3 rounded border shrink-0',
                  t.status === 'completed' && 'bg-green-500/70 border-green-500/70',
                  t.status === 'in_progress' && 'border-zinc-500 bg-zinc-500/20 animate-pulse',
                  t.status === 'pending' && 'border-[#555]',
                )}
              />
              <span
                className={cn(
                  t.status === 'completed' && 'line-through',
                  t.status === 'in_progress' && '',
                  t.status === 'pending' && '',
                )}
                style={{
                  color: t.status === 'completed' ? 'var(--muted-foreground)' : t.status === 'in_progress' ? 'var(--foreground)' : 'var(--secondary-foreground)',
                }}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ─── Block renderer dispatcher ─── */
const BlockRenderer = memo(function BlockRenderer({
  block, isLast, isLive,
}: { block: MessageBlock; isLast?: boolean; isLive?: boolean }) {
  switch (block.type) {
    case 'text':
      return <TextBlock content={block.content} streaming={isLive && isLast} />
    case 'reasoning':
      return <ReasoningBlock
        content={block.content}
        collapsed={block.collapsed}
        done={block.done}
        autoCollapse={!isLast}
      />
    case 'tool_use': {
      if (block.toolName === 'TodoWrite') return <TodoBlock {...block} />
      return <ToolUseBlock {...block} autoCollapse={!isLast} />
    }
    case 'permission_request': return <PermissionBlock {...block} />
    case 'ask_user':
      if (block.question === '__plan_approval__' || block.question.startsWith('__plan_approval__\n')) return <PlanApprovalBlock {...block} />
      return <AskUserBlock {...block} />
    case 'subagent': return null // handled directly in AssistantMessage with expand/focus state
    case 'diff': return <DiffBlock {...block} />
    case 'error': return <ErrorBlock {...block} />
    case 'compact_notice': return <CompactNoticeBlock summary={block.summary} />
    default: return null
  }
})

function FadeIn({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ animation: 'wos-fade-in 160ms ease-out' }}>
      {children}
    </div>
  )
}

/* ─── Message renderers ─── */

interface BranchInfoProps {
  groupId: string
  current: number
  total: number
  onSwitch: (idx: number) => void
}

function BranchNav({ current, total, onSwitch }: BranchInfoProps) {
  return (
    <div className="flex items-center gap-1.5 mt-1.5 px-1">
      <button
        onClick={() => current > 0 && onSwitch(current - 1)}
        disabled={current === 0}
        className="p-0.5 rounded disabled:opacity-30 wos-hover transition-colors"
        style={{ color: 'var(--muted-foreground)' }}
        title="Previous version"
      >
        <ChevronLeft size={12} />
      </button>
      <span style={{ color: 'var(--muted-foreground)', fontSize: '10px' }}>
        {current + 1} / {total}
      </span>
      <button
        onClick={() => current < total - 1 && onSwitch(current + 1)}
        disabled={current === total - 1}
        className="p-0.5 rounded disabled:opacity-30 wos-hover transition-colors"
        style={{ color: 'var(--muted-foreground)' }}
        title="Next version"
      >
        <ChevronRight size={12} />
      </button>
    </div>
  )
}

function UserMessage({
  message,
  onEdit,
  branchInfo,
}: {
  message: DisplayMessage
  onEdit?: (messageId: string, newText: string) => void
  branchInfo?: BranchInfoProps
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [copied, setCopied] = useState(false)

  const textContent = message.blocks
    .filter(b => b.type === 'text')
    .map(b => (b as Extract<MessageBlock, { type: 'text' }>).content)
    .join('')

  const handleEditStart = () => {
    setEditText(textContent)
    setIsEditing(true)
  }

  const handleEditSubmit = () => {
    if (editText.trim() && onEdit) onEdit(message.id, editText.trim())
    setIsEditing(false)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(textContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const stickyStyle: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    background: 'var(--background)',
    paddingTop: 16,
    paddingBottom: 10,
  }

  if (isEditing) {
    return (
      <div style={stickyStyle}>
        <div className="max-w-[680px] mx-auto px-5">
          <div className="rounded-xl" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <textarea
              value={editText}
              onChange={e => setEditText(e.target.value)}
              autoFocus
              className="w-full bg-transparent outline-none resize-none px-4 pt-3 pb-1 leading-relaxed overflow-y-auto"
              style={{ fontSize: '13px', color: 'var(--foreground)', minHeight: '60px', maxHeight: '170px', scrollbarWidth: 'thin' }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSubmit() }
                if (e.key === 'Escape') setIsEditing(false)
              }}
            />
            <div className="flex gap-2 px-4 pb-3">
              <button
                onClick={handleEditSubmit}
                disabled={!editText.trim()}
                className="text-xs px-3 py-1 rounded transition-colors disabled:opacity-40"
                style={{ background: 'var(--primary)', color: '#000', fontSize: '12px' }}
              >
                Send edit
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="text-xs px-3 py-1 rounded transition-colors"
                style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)', fontSize: '12px' }}
              >
                Cancel
              </button>
            </div>
          </div>
          {branchInfo && branchInfo.total > 1 && <BranchNav {...branchInfo} />}
        </div>
      </div>
    )
  }

  return (
    <div style={stickyStyle}>
      <div className="max-w-[680px] mx-auto px-5">
        <div className="group relative">
          <div
            className="rounded-xl px-4 py-3 max-h-[170px] overflow-y-auto"
            style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
          >
            <p className="whitespace-pre-wrap" style={{ color: 'var(--foreground)', fontSize: '13px', lineHeight: '1.7' }}>
              {textContent}
            </p>
          </div>
          {/* Hover actions */}
          <div className="absolute top-1.5 right-2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {onEdit && (
              <button
                onClick={handleEditStart}
                className="p-1.5 rounded wos-hover transition-colors"
                style={{ color: 'var(--border-strong)' }}
                title="Edit message"
              >
                <Pencil size={11} />
              </button>
            )}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded wos-hover transition-colors"
              style={{ color: 'var(--border-strong)' }}
              title="Copy message"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        </div>
        {branchInfo && branchInfo.total > 1 && <BranchNav {...branchInfo} />}
      </div>
    </div>
  )
}

function StreamingIndicator({ blocks }: { blocks: MessageBlock[] }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const last = blocks[blocks.length - 1]
  let label = 'Thinking…'
  if (!last) label = 'Connecting…'
  else if (last.type === 'reasoning' && !last.done) label = 'Reasoning…'
  else if (last.type === 'text') label = 'Writing…'
  else if (last.type === 'tool_use') {
    label = last.status === 'preparing'
      ? `Preparing ${last.toolName}…`
      : last.status === 'running'
      ? `Running ${last.toolName}…`
      : `Finishing ${last.toolName}…`
  }
  else if (last.type === 'permission_request') label = 'Waiting for you — permission'
  else if (last.type === 'ask_user') label = 'Waiting for your answer…'
  else if (last.type === 'subagent') label = 'Running sub-agent…'

  const slow = elapsed >= 15
  return (
    <div className="flex items-center gap-2 pt-1" aria-live="polite">
      {[0, 110, 220].map(d => (
        <span
          key={d}
          className="w-1 h-1 rounded-full animate-bounce"
          style={{ background: slow ? 'var(--surface-stronger)' : 'var(--border-strong)', animationDelay: `${d}ms` }}
        />
      ))}
      <span style={{ color: slow ? 'var(--foreground)' : 'var(--muted-foreground)', fontSize: '11px' }}>
        {label}{slow && ` (${elapsed}s)`}
      </span>
    </div>
  )
}

function AssistantMessage({ message, isStreaming }: { message: DisplayMessage; isStreaming: boolean }) {
  const [copied, setCopied] = useState(false)
  const { sendMessage, setFocusedAgentId } = useAgentStore()
  const textContent = message.blocks
    .filter(b => b.type === 'text')
    .map(b => (b as Extract<MessageBlock, { type: 'text' }>).content)
    .join('')

  const hasInterruption = !isStreaming && blocksHaveInterruption(message.blocks)
  void hasInterruption // intentionally unused — banner removed

  // Expand state: in-flight (no result) runs expanded by default
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const b of message.blocks) {
      if (b.type === 'subagent') {
        init[b.agentId] = b.result === undefined
      }
    }
    return init
  })

  // Sync new subagent blocks into expandedRuns when blocks update
  useEffect(() => {
    setExpandedRuns(prev => {
      const next = { ...prev }
      let changed = false
      for (const b of message.blocks) {
        if (b.type === 'subagent' && !(b.agentId in next)) {
          next[b.agentId] = b.result === undefined
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [message.blocks])

  const handleCopy = () => {
    navigator.clipboard.writeText(textContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (message.blocks.length === 0 && isStreaming) {
    return (
      <div className="max-w-[680px] mx-auto px-5 pb-3">
        <StreamingIndicator blocks={message.blocks} />
      </div>
    )
  }

  return (
    <div className="group max-w-[680px] mx-auto px-5 pb-3">
      <div style={{ fontSize: '13px' }}>
        {message.blocks.map((block, i) => {
          const key = block.type === 'tool_use'
            ? `t-${block.toolId}`
            : block.type === 'ask_user'
              ? `q-${block.questionId}`
              : block.type === 'permission_request'
                ? `p-${block.toolId}`
                : block.type === 'subagent'
                  ? `s-${block.agentId}`
                  : `${block.type}-${i}`
          const isLast = i === message.blocks.length - 1

          if (block.type === 'subagent') {
            return (
              <FadeIn key={key}>
                <SubagentBlock
                  {...block}
                  expanded={expandedRuns[block.agentId] ?? false}
                  onToggle={() => setExpandedRuns(prev => ({ ...prev, [block.agentId]: !prev[block.agentId] }))}
                  onFocus={() => setFocusedAgentId(block.agentId)}
                />
              </FadeIn>
            )
          }

          return (
            <FadeIn key={key}>
              <BlockRenderer block={block} isLast={isLast} isLive={isStreaming} />
            </FadeIn>
          )
        })}
        {isStreaming && <StreamingIndicator blocks={message.blocks} />}
      </div>
      {!isStreaming && textContent && (
        <div className="flex items-center gap-0.5 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded wos-hover transition-colors"
            style={{ color: 'var(--border-strong)' }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
      )}
      {hasInterruption && null /* banner removed */}
    </div>
  )
}

/* ─── Slash / @ command types ─── */
type MeetingChip = { id: string; title: string; date?: string }

const SLASH_COMMANDS = [
  { id: 'plan',    hint: '/plan',    desc: 'Switch to plan mode — agent plans before executing' },
  { id: 'yolo',   hint: '/yolo',    desc: 'Fully autonomous — no interruptions' },
  { id: 'default',hint: '/default', desc: 'Switch to default mode' },
  { id: 'model',  hint: '/model',   desc: 'Choose AI model (provider + model selection)' },
  { id: 'new',    hint: '/new',     desc: 'Start a new conversation' },
  { id: 'clear',  hint: '/clear',   desc: 'Start a fresh conversation (clear current chat)' },
  { id: 'resume', hint: '/resume',  desc: 'Resume a recent conversation' },
  { id: 'export', hint: '/export',  desc: 'Export this conversation to a Markdown file' },
  { id: 'agent',  hint: '/agent',   desc: 'Pin a subagent (e.g. /agent meeting) for the next message' },
  { id: 'meeting',hint: '/meeting', desc: 'Attach an analyzed meeting as context' },
  { id: 'file',   hint: '/file',    desc: 'Attach a file from your workspace or computer' },
  { id: 'help',   hint: '/help',    desc: 'Show all commands' },
] as const

// `@` is a pure file typeahead — no static menu. Use slash commands (`/meeting`) for non-file attachments.

/* ─── Composer ─── */
function Composer() {
  const activeConversationId = useAgentStore(s => s.activeConversationId)
  const [input, setInput] = useState(() => useUIStore.getState().getDraft(activeConversationId))
  const [mode, setMode] = useState('default')
  const [showModeDropdown, setShowModeDropdown] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [meetingChips, setMeetingChips] = useState<MeetingChip[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  // Slash command state
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)

  // Meeting sub-picker state
  const [meetingSubOpen, setMeetingSubOpen] = useState(false)
  const [analyzedMeetings, setAnalyzedMeetings] = useState<MeetingChip[]>([])
  const [pinnedAgent, setPinnedAgent] = useState<string | null>(null)

  // File fuzzy-search sub-picker state
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [filePickerQuery, setFilePickerQuery] = useState('')
  const [filePickerResults, setFilePickerResults] = useState<string[]>([])
  const [filePickerIndex, setFilePickerIndex] = useState(0)
  const filePickerSearchRef = useRef<HTMLInputElement>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const partialStartRef = useRef<number>(-1)

  const { isStreaming, sendMessage, cancelAgent, currentMode, setMode: storeSetMode, startNewConversation, currentModel, setModel } = useAgentStore()
  const { workspaces } = useWorkspaceStore()
  const setDraft = useUIStore(s => s.setDraft)
  const clearDraft = useUIStore(s => s.clearDraft)

  useEffect(() => { setMode(currentMode) }, [currentMode])

  // When the user switches conversations, swap the composer to that conversation's
  // persisted draft (or empty for a fresh chat).
  useEffect(() => {
    const next = useUIStore.getState().getDraft(activeConversationId)
    setInput(next)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    })
  }, [activeConversationId])

  const resizeTextarea = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 150) + 'px'
  }

  const filteredSlashCmds = SLASH_COMMANDS.filter(c =>
    c.id.startsWith(slashFilter.toLowerCase()) || slashFilter === ''
  )

  const closeMenus = () => {
    setSlashOpen(false)
    setMeetingSubOpen(false)
    setFilePickerOpen(false)
  }

  const openFilePicker = useCallback(async (query = '') => {
    setFilePickerQuery(query)
    setFilePickerIndex(0)
    setFilePickerOpen(true)
    const wsId = workspaces[0]?.id
    if (!wsId) { setFilePickerResults([]); return }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (window.wos as any).globWorkspace({ workspaceId: wsId, query })
      setFilePickerResults(result?.files ?? [])
    } catch {
      setFilePickerResults([])
    }
    setTimeout(() => filePickerSearchRef.current?.focus(), 50)
  }, [workspaces])

  const refreshFileSearch = useCallback(async (q: string) => {
    setFilePickerQuery(q)
    setFilePickerIndex(0)
    const wsId = workspaces[0]?.id
    if (!wsId) { setFilePickerResults([]); return }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (window.wos as any).globWorkspace({ workspaceId: wsId, query: q })
      setFilePickerResults(result?.files ?? [])
    } catch {
      setFilePickerResults([])
    }
  }, [workspaces])

  const handleModeChange = (id: string) => {
    setMode(id)
    storeSetMode(id)
    setShowModeDropdown(false)
  }

  const executeSlash = useCallback(async (cmdId: string) => {
    closeMenus()
    setInput('')
    setTimeout(resizeTextarea, 0)

    switch (cmdId) {
      case 'plan':    handleModeChange('plan');    break
      case 'yolo':   handleModeChange('yolo');   break
      case 'default': handleModeChange('default'); break
      case 'model':  setShowModelPicker(true);  break
      case 'file':   void openFilePicker(''); break
      case 'new': {
        try {
          await startNewConversation()
        } catch {
          /* swallow — store surfaces toast */
        }
        break
      }
      case 'clear': {
        try {
          await startNewConversation()
          setAttachments([])
          setMeetingChips([])
          setInput('')
          toast.success('Started a fresh conversation')
        } catch {
          /* swallow — store surfaces toast */
        }
        break
      }
      case 'resume': {
        try {
          const { conversations, loadConversations, loadConversation } = useAgentStore.getState()
          if (!conversations.length) {
            await loadConversations()
          }
          const list = useAgentStore.getState().conversations
          if (!list.length) {
            toast.message('No previous conversations found')
            break
          }
          // Pick the most recently updated conversation that isn't already active.
          const activeId = useAgentStore.getState().activeConversationId
          const candidate = list.find(c => c.id !== activeId) ?? list[0]
          if (candidate) {
            await loadConversation(candidate.id)
            toast.success(`Resumed: ${candidate.title || 'Untitled'}`)
          }
          setInput('')
        } catch (err) {
          toast.error(`Resume failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }
      case 'export': {
        const convId = useAgentStore.getState().activeConversationId
        if (!convId) {
          toast.error('No active conversation to export')
          break
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (window.wos as any).exportConversation?.(convId)
          if (result?.ok) toast.success(`Exported to ${result.path}`)
          else if (!result?.canceled) toast.error(`Export failed: ${result?.error ?? 'unknown error'}`)
        } catch (err) {
          toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }
      case 'help':
        setSlashFilter('')
        setSlashIndex(0)
        setSlashOpen(true)
        setInput('/')
        break
      case 'agent': {
        // Pin a subagent for the next message. Argument may follow on same line: "/agent meeting"
        const rest = input.replace(/^\/agent\s*/i, '').trim().split(/\s+/)[0] ?? ''
        if (rest) {
          setPinnedAgent(rest.toLowerCase())
          setInput('')
          toast.success(`Pinned agent: ${rest}`)
        } else {
          if (pinnedAgent) {
            setPinnedAgent(null)
            toast.success('Cleared pinned agent')
          } else {
            setInput('/agent ')
            toast.message('Type an agent name (e.g. meeting), then press Enter or send.')
          }
        }
        break
      }
      case 'meeting': {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = await (window.wos as any).listAnalyzedMeetings?.() ?? []
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setAnalyzedMeetings(raw.map((m: any) => ({ id: m.id ?? m.meetingId, title: m.title, date: m.date ?? m.startTime })))
        } catch {
          setAnalyzedMeetings([])
        }
        setMeetingSubOpen(true)
        break
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFilePicker])

  const addMeetingChip = (meeting: MeetingChip) => {
    setMeetingChips(prev => prev.some(m => m.id === meeting.id) ? prev : [...prev, meeting])
    setMeetingSubOpen(false)
    textareaRef.current?.focus()
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    setDraft(activeConversationId, val)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 150) + 'px'

    // Slash detection: value starts with /
    if (val.startsWith('/')) {
      const filter = val.slice(1)
      setSlashFilter(filter)
      setSlashOpen(true)
      setSlashIndex(0)
      setMeetingSubOpen(false)
    } else {
      setSlashOpen(false)
    }

    // @ detection: open the workspace file typeahead immediately with whatever the user is typing.
    const atMatch = /(?:^|\s)@(\w*)$/.exec(val)
    if (atMatch) {
      const q = atMatch[1] ?? ''
      setSlashOpen(false)
      if (!filePickerOpen) void openFilePicker(q)
      else void refreshFileSearch(q)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Navigate slash menu
    if (slashOpen && filteredSlashCmds.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, filteredSlashCmds.length - 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter')     { e.preventDefault(); void executeSlash(filteredSlashCmds[slashIndex]?.id ?? ''); return }
      if (e.key === 'Escape')    { e.preventDefault(); closeMenus(); return }
      if (e.key === 'Tab')       { e.preventDefault(); void executeSlash(filteredSlashCmds[slashIndex]?.id ?? ''); return }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && isStreaming) cancelAgent()
  }

  const handleSend = () => {
    const hasContent = input.trim() || meetingChips.length > 0
    if (!hasContent || isStreaming) return
    closeMenus()

    let text = input.trim()
    if (meetingChips.length > 0) {
      text += '\n\n[Attached meeting context: ' + meetingChips.map(m => m.title).join(', ') + ']'
    }

    if (pinnedAgent) {
      text = `[Use the Task tool with preset="${pinnedAgent}" to handle this request.]\n\n${text}`
    }

    sendMessage(text, attachments)
    setInput('')
    clearDraft(activeConversationId)
    setAttachments([])
    setMeetingChips([])
    setPinnedAgent(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    const read = await Promise.all(files.map(async f => ({ name: f.name, content: await f.text(), type: f.type })))
    setAttachments(prev => [...prev, ...read])
  }

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const read = await Promise.all(files.map(async f => ({ name: f.name, content: await f.text(), type: f.type })))
    setAttachments(prev => [...prev, ...read])
    e.target.value = ''
  }

  const activeMode = MODES.find(m => m.id === mode) ?? MODES[0]
  const ModeIcon = activeMode.icon
  const canSend = (input.trim() || meetingChips.length > 0) && !isStreaming

  return (
    <div
      ref={dropRef}
      className="shrink-0 pb-3 pt-1 px-5"
      onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="max-w-[680px] mx-auto relative">
        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl pointer-events-none"
            style={{ border: '2px dashed #3b82f6', background: 'rgba(59,130,246,0.05)' }}>
            <p className="text-sm text-blue-400">Drop files to attach</p>
          </div>
        )}

        {/* Slash command picker */}
        {slashOpen && filteredSlashCmds.length > 0 && (
          <div className="absolute bottom-full mb-2 left-0 right-0 z-50 rounded-xl overflow-hidden py-1"
            style={{ background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
            {filteredSlashCmds.map((cmd, i) => (
              <button
                key={cmd.id}
                onMouseDown={e => { e.preventDefault(); void executeSlash(cmd.id) }}
                className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
                style={{ background: i === slashIndex ? 'var(--selection-bg)' : 'transparent' }}
              >
                <code className="text-xs font-mono shrink-0 w-20" style={{ color: 'var(--amber)' }}>{cmd.hint}</code>
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{cmd.desc}</span>
              </button>
            ))}
          </div>
        )}

        {/* Meeting sub-picker */}
        {meetingSubOpen && (
          <div className="absolute bottom-full mb-2 left-0 right-0 z-50 rounded-xl overflow-hidden"
            style={{ background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxHeight: '260px', overflowY: 'auto' }}>
            <div className="flex items-center justify-between px-3 py-2 sticky top-0" style={{ background: 'var(--popover)', borderBottom: '1px solid var(--border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Select a meeting</span>
              <button onMouseDown={() => setMeetingSubOpen(false)} style={{ color: 'var(--muted-foreground)' }}>
                <X size={12} />
              </button>
            </div>
            {analyzedMeetings.length === 0 ? (
              <div className="px-3 py-5 text-center">
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>No analyzed meetings yet</span>
              </div>
            ) : (
              analyzedMeetings.map(m => (
                <button
                  key={m.id}
                  onMouseDown={() => addMeetingChip(m)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left wos-hover-sm transition-colors"
                >
                  <span className="text-xs flex-1 truncate" style={{ color: 'var(--foreground)' }}>{m.title}</span>
                  {m.date && <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{m.date}</span>}
                </button>
              ))
            )}
          </div>
        )}

        {/* File fuzzy-search sub-picker */}
        {filePickerOpen && (
          <div className="absolute bottom-full mb-2 left-0 right-0 z-50 rounded-xl overflow-hidden"
            style={{ background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxHeight: '280px', display: 'flex', flexDirection: 'column' }}>
            <div className="flex items-center gap-2 px-3 py-2 sticky top-0" style={{ background: 'var(--popover)', borderBottom: '1px solid var(--border)' }}>
              <Search size={12} style={{ color: 'var(--muted-foreground)' }} />
              <input
                ref={filePickerSearchRef}
                value={filePickerQuery}
                onChange={e => void refreshFileSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setFilePickerIndex(i => Math.min(i + 1, filePickerResults.length)); return }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setFilePickerIndex(i => Math.max(i - 1, 0)); return }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const f = filePickerResults[filePickerIndex]
                    if (f) {
                      void (async () => {
                        const wsId = workspaces[0]?.id
                        let content = `[File: ${f}]`
                        if (wsId) {
                          try {
                            const res = await window.wos.readWorkspaceFile({ workspaceId: wsId, relPath: f })
                            if (res.ok && typeof res.content === 'string') content = res.content
                          } catch { /* fall back to placeholder */ }
                        }
                        setAttachments(prev => [...prev, { name: f, content, type: 'text/plain' }])
                      })()
                      setFilePickerOpen(false)
                    } else if (filePickerIndex === filePickerResults.length) {
                      fileInputRef.current?.click()
                      setFilePickerOpen(false)
                    }
                    return
                  }
                  if (e.key === 'Escape') { setFilePickerOpen(false); textareaRef.current?.focus(); return }
                }}
                placeholder="Search files…"
                className="flex-1 bg-transparent outline-none text-xs"
                style={{ color: 'var(--foreground)' }}
              />
              <button onMouseDown={() => setFilePickerOpen(false)} style={{ color: 'var(--muted-foreground)' }}>
                <X size={11} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {!workspaces[0] && (
                <NoWorkspacePrompt onClose={() => setFilePickerOpen(false)} />
              )}
              {workspaces[0] && filePickerResults.length === 0 && filePickerQuery !== '' && (
                <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>No files found</div>
              )}
              {filePickerResults.map((f, i) => (
                <button
                  key={f}
                  onMouseDown={() => {
                    void (async () => {
                      const wsId = workspaces[0]?.id
                      let content = `[File: ${f}]`
                      if (wsId) {
                        try {
                          const res = await window.wos.readWorkspaceFile({ workspaceId: wsId, relPath: f })
                          if (res.ok && typeof res.content === 'string') content = res.content
                        } catch { /* fall back to placeholder */ }
                      }
                      setAttachments(prev => [...prev, { name: f, content, type: 'text/plain' }])
                    })()
                    setFilePickerOpen(false)
                    textareaRef.current?.focus()
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                  style={{ background: i === filePickerIndex ? 'var(--selection-bg)' : 'transparent' }}
                >
                  <File size={11} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                  <span className="text-xs truncate" style={{ color: 'var(--foreground)' }}>{f}</span>
                </button>
              ))}
              {/* Browse fallback */}
              <button
                onMouseDown={() => { fileInputRef.current?.click(); setFilePickerOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                style={{
                  background: filePickerIndex === filePickerResults.length ? 'var(--selection-bg)' : 'transparent',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Plus size={11} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Browse computer…</span>
              </button>
            </div>
          </div>
        )}

        <div
          className="rounded-2xl relative"
          style={{
            background: 'var(--card)',
            border: `1px solid ${isDragOver ? '#3b82f6' : 'var(--border)'}`,
          }}
        >
          {/* Pinned agent chip */}
          {pinnedAgent && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
                style={{ background: 'rgba(120, 200, 255, 0.08)', border: '1px solid var(--border-strong)' }}>
                <span style={{ fontSize: '10px' }}>🤖</span>
                <span style={{ color: 'var(--foreground)', fontSize: '11px' }}>agent: {pinnedAgent}</span>
                <button
                  onClick={() => setPinnedAgent(null)}
                  className="hover:opacity-100 transition-opacity"
                  style={{ color: 'var(--amber)', opacity: 0.7 }}
                >
                  <X size={9} />
                </button>
              </div>
            </div>
          )}

          {/* Meeting chips */}
          {meetingChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {meetingChips.map(chip => (
                <div key={chip.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
                  style={{ background: 'var(--surface-base)', border: '1px solid var(--border-strong)' }}>
                  <span style={{ fontSize: '10px' }}>📋</span>
                  <span style={{ color: 'var(--foreground)', fontSize: '11px', maxWidth: '160px' }} className="truncate">{chip.title}</span>
                  <button
                    onClick={() => setMeetingChips(prev => prev.filter(m => m.id !== chip.id))}
                    className="hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--amber)', opacity: 0.7 }}
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* File attachments */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {attachments.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
                  style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                  <File size={10} style={{ color: 'var(--muted-foreground)' }} />
                  <span style={{ color: 'var(--secondary-foreground)', fontSize: '11px' }}>{a.name}</span>
                  <button
                    onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                    className="ml-0.5 hover:text-red-400 transition-colors"
                    style={{ color: 'var(--border-strong)' }}
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Yolo warning */}
          {mode === 'yolo' && (
            <div className="flex items-center gap-1.5 px-4 pt-2">
              <div className="flex items-center gap-1 text-xs rounded-full px-2 py-0.5"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
                <Zap size={10} />
                <span>Yolo — fully autonomous</span>
              </div>
            </div>
          )}

          {/* Textarea */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Send a message… (/ for commands, @ to attach a file)"
              disabled={isStreaming}
              className="w-full bg-transparent outline-none resize-none leading-relaxed disabled:cursor-not-allowed"
              style={{ minHeight: '32px', maxHeight: '150px', fontSize: '13px', color: 'var(--foreground)' }}
              rows={1}
            />
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-0.5">
            {/* Attach file */}
            <button
              onClick={() => void openFilePicker('')}
              className="w-5 h-5 rounded flex items-center justify-center wos-hover transition-colors"
              style={{ color: 'var(--muted-foreground)' }}
              title="Attach file from workspace"
            >
              <Plus size={13} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />

            {/* Mode picker */}
            <div className="relative">
              <button
                onClick={() => setShowModeDropdown(o => !o)}
                className="flex items-center gap-0.5 px-2 py-1 rounded-lg wos-hover transition-colors"
                style={{ color: mode === 'yolo' ? 'var(--terracotta)' : 'var(--muted-foreground)', fontSize: '12px' }}
              >
                <ModeIcon size={11} />
                <span className="ml-1">{activeMode.label}</span>
                <ChevronDown size={10} className="ml-0.5" />
              </button>
              {showModeDropdown && (
                <div className="absolute bottom-full mb-1.5 left-0 rounded-xl overflow-hidden z-50 py-1"
                  style={{
                    background: 'var(--popover)',
                    border: '1px solid var(--border)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                    minWidth: '200px',
                  }}
                >
                  {MODES.map(m => (
                    <button
                      key={m.id}
                      onClick={() => handleModeChange(m.id)}
                      className="w-full text-left px-3 py-2 wos-hover transition-colors flex items-start gap-2"
                      style={{ color: mode === m.id ? 'var(--foreground)' : 'var(--muted-foreground)' }}
                    >
                      <m.icon size={13} className="mt-0.5 shrink-0" />
                      <div>
                        <div style={{ fontSize: '12px', fontWeight: 500 }}>{m.label}</div>
                        <div style={{ fontSize: '10px', color: 'var(--border-strong)', marginTop: '1px' }}>{m.description}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1" />

            {/* Cancel / Send */}
            {isStreaming ? (
              <button
                onClick={cancelAgent}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors"
                style={{ background: 'var(--card)', color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}
              >
                <X size={10} /> Stop
              </button>
            ) : (
              <>
                <MicButton
                  onPartial={(text) => {
                    const trimmed = text.trim()
                    if (!trimmed) return
                    setInput(prev => {
                      if (partialStartRef.current < 0) partialStartRef.current = prev.length
                      return prev.slice(0, partialStartRef.current) + trimmed
                    })
                    setTimeout(resizeTextarea, 0)
                  }}
                  onCommitText={(text) => {
                    const el = textareaRef.current
                    const t = text.trim()
                    partialStartRef.current = -1
                    if (!t) return
                    if (!el) {
                      setInput(prev => (prev ? prev + ' ' : '') + t)
                      return
                    }
                    const start = el.selectionStart ?? input.length
                    const end = el.selectionEnd ?? input.length
                    const before = input.slice(0, start)
                    const after = input.slice(end)
                    const needsSpace = before.length > 0 && !/\s$/.test(before)
                    const insert = (needsSpace ? ' ' : '') + t + (after && !/^\s/.test(after) ? ' ' : '')
                    const next = before + insert + after
                    setInput(next)
                    requestAnimationFrame(() => {
                      el.focus()
                      resizeTextarea()
                      const caret = (before + insert).length
                      try { el.setSelectionRange(caret, caret) } catch { /* ignore */ }
                    })
                  }}
                />
                <button
                  onClick={canSend ? handleSend : undefined}
                  disabled={!canSend}
                  className={cn(
                    'w-6 h-6 rounded-full flex items-center justify-center transition-all',
                    canSend ? 'bg-white text-black hover:bg-[#e8e8e8]' : 'opacity-50 cursor-not-allowed'
                  )}
                  style={canSend ? undefined : { color: 'var(--muted-foreground)' }}
                  aria-label="Send"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Model picker modal — rendered outside the inner div so it can be full-screen */}
      {showModelPicker && (
        <ModelPickerModal
          current={currentModel}
          onSelect={async (modelId) => { await setModel(modelId) }}
          onClose={() => setShowModelPicker(false)}
        />
      )}
    </div>
  )
}

/* ─── Main ChatView ─── */
export function ChatView() {
  const { currentMessages, isStreaming, activeBranches, switchBranch, editMessage, focusedAgentId, setFocusedAgentId } = useAgentStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  // Auto scroll
  useEffect(() => {
    if (isStreaming) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [currentMessages, isStreaming])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
  }, [])

  // How many unique branches exist per branch group (counting user messages only)
  const branchCounts = React.useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of currentMessages) {
      if (m.branchGroupId && m.role === 'user') {
        counts[m.branchGroupId] = Math.max(counts[m.branchGroupId] ?? 0, (m.branchIndex ?? 0) + 1)
      }
    }
    return counts
  }, [currentMessages])

  // Find the live focused subagent block so the side panel can render it.
  const focusedBlock = React.useMemo(() => {
    if (!focusedAgentId) return null
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i]
      if (m.role !== 'assistant') continue
      for (const b of m.blocks) {
        if (b.type === 'subagent' && b.agentId === focusedAgentId) {
          return b as Extract<MessageBlock, { type: 'subagent' }>
        }
      }
    }
    return null
  }, [focusedAgentId, currentMessages])

  // Focus metadata: find agentName for the focused id so we can show it in the panel
  const focusMeta = React.useMemo(() => {
    if (!focusedAgentId) return null
    if (focusedBlock) {
      return {
        agentName: focusedBlock.agentName ?? 'task',
        colorSeed: focusedBlock.colorSeed,
        shortId: focusedAgentId.slice(0, 6),
      }
    }
    return { agentName: 'agent', colorSeed: 0, shortId: focusedAgentId.slice(0, 6) }
  }, [focusedAgentId, focusedBlock])

  // Group into user/assistant pairs, filtering to active branch per group.
  // Note: when a subagent is focused we keep the main chat fully visible —
  // focus opens a side panel instead of filtering the conversation.
  const turns = React.useMemo(() => {
    const activeMessages = currentMessages.filter(m => {
      if (!m.branchGroupId) return true
      return (m.branchIndex ?? 0) === (activeBranches[m.branchGroupId] ?? 0)
    })

    const pairs: Array<{ user: DisplayMessage; assistant: DisplayMessage | null }> = []
    let i = 0
    while (i < activeMessages.length) {
      const msg = activeMessages[i]
      if (msg.role === 'user') {
        const next = activeMessages[i + 1]
        pairs.push({
          user: msg,
          assistant: next?.role === 'assistant' ? next : null,
        })
        i += next?.role === 'assistant' ? 2 : 1
      } else {
        i++
      }
    }
    return pairs
  }, [currentMessages, activeBranches])

  const focusColor = focusMeta ? getAgentColor(focusMeta.colorSeed) : null

  return (
    <div className="flex h-full" style={{ background: 'var(--background)' }}>
      <div className="flex flex-col flex-1 min-w-0 h-full relative">
      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={handleScroll}
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--border-strong) transparent' }}
      >
        {turns.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>
              Start a conversation…
            </p>
          </div>
        ) : (
          <div className="min-h-full flex flex-col">
            <div className="flex-1" />
            {turns.map((turn, i) => {
              const groupId = turn.user.branchGroupId
              const branchInfo: BranchInfoProps | undefined =
                groupId && branchCounts[groupId] > 1
                  ? {
                      groupId,
                      current: activeBranches[groupId] ?? 0,
                      total: branchCounts[groupId],
                      onSwitch: (idx: number) => switchBranch(groupId, idx),
                    }
                  : undefined

              return (
                <div key={turn.user.id}>
                  <UserMessage
                    message={turn.user}
                    onEdit={!isStreaming ? editMessage : undefined}
                    branchInfo={branchInfo}
                  />
                  {turn.assistant && (
                    <AssistantMessage
                      message={turn.assistant}
                      isStreaming={isStreaming && i === turns.length - 1}
                    />
                  )}
                  {!turn.assistant && isStreaming && i === turns.length - 1 && (
                    <div className="max-w-[680px] mx-auto px-5 pb-3">
                      <StreamingIndicator blocks={[]} />
                    </div>
                  )}
                </div>
              )
            })}
            <div ref={bottomRef} className="h-1" />
          </div>
        )}
      </div>

      {/* Scroll FAB */}
      {showScrollBtn && (
        <div className="absolute bottom-24 right-6 z-20">
          <button
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="w-7 h-7 rounded-full flex items-center justify-center transition-all hover:scale-105"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border-strong)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              color: 'var(--muted-foreground)',
            }}
          >
            <ArrowDown size={12} />
          </button>
        </div>
      )}

      <Composer />
      </div>

      {/* Right side panel — focused subagent tracker */}
      {focusMeta && focusColor && (
        <SubagentFocusPanel
          block={focusedBlock}
          agentName={focusMeta.agentName}
          shortId={focusMeta.shortId}
          color={focusColor}
          onClose={() => setFocusedAgentId(null)}
        />
      )}
    </div>
  )
}

function SubagentFocusPanel({
  block, agentName, shortId, color, onClose,
}: {
  block: Extract<MessageBlock, { type: 'subagent' }> | null
  agentName: string
  shortId: string
  color: ReturnType<typeof getAgentColor>
  onClose: () => void
}) {
  const merged = useMemo(() => block ? mergeEvents(block.events) : [], [block])
  const tailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [merged.length])

  const isRunning = !!block && block.result === undefined && !block.interrupted
  let statusLabel = 'idle'
  let statusColor: string = color.text
  if (block) {
    if (block.interrupted || block.result === '[interrupted]') { statusLabel = 'cancelled'; statusColor = '#94a3b8' }
    else if (block.result !== undefined) { statusLabel = 'done'; statusColor = '#4ade80' }
    else { statusLabel = 'running'; statusColor = color.text }
  }

  return (
    <aside
      className="flex flex-col h-full shrink-0"
      style={{
        width: 380,
        borderLeft: '1px solid var(--border)',
        background: 'var(--background)',
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ background: color.bg, borderBottom: `1px solid ${color.border}` }}
      >
        <span style={{ color: color.text }}>🔍</span>
        <span className="text-xs font-medium font-mono" style={{ color: color.text }}>
          {agentName}#{shortId}
        </span>
        <span
          className="text-[10px] shrink-0 font-medium px-1.5 py-0.5 rounded-full"
          style={{ color: statusColor, background: 'rgba(0,0,0,0.2)' }}
        >
          {statusLabel}
        </span>
        <span className="flex-1" />
        <button
          onClick={onClose}
          className="text-[11px] px-2 py-0.5 rounded transition-colors wos-hover"
          style={{ color: color.text, border: `1px solid ${color.border}` }}
          title="Close focus panel"
        >
          Unfocus
        </button>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--border-strong) transparent' }}
      >
        {!block ? (
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            Waiting for subagent events…
          </p>
        ) : (
          <>
            <p className="text-[10px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
              {block.prompt}
            </p>
            {merged.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                {isRunning ? 'Starting…' : 'No events emitted.'}
              </p>
            ) : (
              <div className="space-y-1">
                {merged.map((g, i) => (
                  <MergedEventLine key={i} group={g} color={color} />
                ))}
              </div>
            )}
            {block.result && block.result !== '[interrupted]' && (
              <div
                className="mt-3 pt-2 text-xs"
                style={{ borderTop: `1px solid ${color.border}`, color: 'var(--secondary-foreground)' }}
              >
                ✓ {block.result}
              </div>
            )}
            <div ref={tailRef} className="h-1" />
          </>
        )}
      </div>
    </aside>
  )
}
