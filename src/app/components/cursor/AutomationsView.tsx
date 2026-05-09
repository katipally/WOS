import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertCircle, Calendar, CheckCircle2, ChevronDown, ChevronRight, Clock,
  Copy, Edit2, Globe, Loader2, MessageSquare, Pause, Play, Plus, Save, Sparkles,
  RefreshCw, Settings as SettingsIcon, Trash2, Webhook, XCircle, Zap, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../../lib/utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type AutomationKind = 'schedule' | 'hook' | 'webhook'
type ResultDelivery = 'silent' | 'notify' | 'chat' | 'external'
type Section = 'all' | 'schedule' | 'hook' | 'webhook'
type WizardStage = 'idle' | 'generating' | 'clarifying' | 'configuring' | 'creating'

interface ToolMeta { name: string; description: string; tags: string[] }
interface ToolCallRecord { tool: string; args?: unknown; result?: unknown; error?: string }

interface PendingQuestion {
  automationId: string
  runId: string
  questionId: string
  question: string
  choices?: string[]
  extras?: unknown
}

const KIND_META: Record<AutomationKind, { label: string; icon: React.FC<{ className?: string }>; color: string }> = {
  schedule: { label: 'Schedule', icon: Calendar, color: 'text-blue-400' },
  hook: { label: 'Event hook', icon: Zap, color: 'text-amber-400' },
  webhook: { label: 'Webhook', icon: Webhook, color: 'text-emerald-400' },
}

const DELIVERY_OPTIONS: Array<{ value: ResultDelivery; label: string; description: string }> = [
  { value: 'chat', label: 'Chat', description: 'Posts result as a message' },
  { value: 'notify', label: 'Notify', description: 'Shows an OS notification' },
  { value: 'silent', label: 'Silent', description: 'Run log only' },
  { value: 'external', label: 'External', description: 'Delivers to an external target' },
]

const SCHEDULE_PRESETS: Array<{ label: string; config: Record<string, unknown> }> = [
  { label: 'Every hour', config: { mode: 'cron', cron: '0 * * * *' } },
  { label: 'Daily 9am', config: { mode: 'cron', cron: '0 9 * * *' } },
  { label: 'Weekdays 9am', config: { mode: 'cron', cron: '0 9 * * 1-5' } },
  { label: 'Every 30m', config: { mode: 'every', every: '30m' } },
  { label: 'Weekly Mon', config: { mode: 'cron', cron: '0 9 * * 1' } },
]

const HOOK_EVENTS = [
  { value: 'meeting:saved', label: 'Meeting saved' },
  { value: 'session:new', label: 'Session started' },
  { value: 'app:connected', label: 'App connected' },
]

const NL_PATTERNS: Array<{ p: RegExp; c: Record<string, unknown>; d: string }> = [
  { p: /every\s+hour/i, c: { mode: 'cron', cron: '0 * * * *' }, d: 'Every hour' },
  { p: /weekday.*(9\s*am)/i, c: { mode: 'cron', cron: '0 9 * * 1-5' }, d: 'Weekdays at 9am' },
  { p: /daily.*(9\s*am)/i, c: { mode: 'cron', cron: '0 9 * * *' }, d: 'Daily at 9am' },
  { p: /every\s+30\s*min/i, c: { mode: 'every', every: '30m' }, d: 'Every 30 minutes' },
  { p: /every\s+15\s*min/i, c: { mode: 'every', every: '15m' }, d: 'Every 15 minutes' },
  { p: /midnight/i, c: { mode: 'cron', cron: '0 0 * * *' }, d: 'Daily at midnight' },
  { p: /weekly.*monday|every\s+week/i, c: { mode: 'cron', cron: '0 9 * * 1' }, d: 'Weekly on Monday' },
]

function parseNL(text: string): { config: Record<string, unknown>; desc: string } | null {
  for (const { p, c, d } of NL_PATTERNS) {
    if (p.test(text)) return { config: c, desc: d }
  }
  const tm = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (tm) {
    let h = parseInt(tm[1]); const m = parseInt(tm[2] ?? '0'); const ap = tm[3].toLowerCase()
    if (ap === 'pm' && h !== 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    return { config: { mode: 'cron', cron: `${m} ${h} * * *` }, desc: `Daily at ${tm[1]}${tm[2] ? ':' + tm[2] : ''}${tm[3]}` }
  }
  const fields = text.trim().split(/\s+/)
  if (fields.length === 5 && fields.every(f => /^[\d*/,-]+$/.test(f))) {
    return { config: { mode: 'cron', cron: text.trim() }, desc: `cron: ${text.trim()}` }
  }
  return null
}

function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return '—'
  const t = new Date(date).getTime()
  const diff = Date.now() - t
  if (diff < 0) {
    const fwd = -diff
    if (fwd < 60_000) return `in ${Math.round(fwd / 1000)}s`
    if (fwd < 3_600_000) return `in ${Math.round(fwd / 60_000)}m`
    if (fwd < 86_400_000) return `in ${Math.round(fwd / 3_600_000)}h`
    return new Date(t).toLocaleString()
  }
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(t).toLocaleDateString()
}

function describeConfig(a: AutomationRow): string {
  const c = a.config || {}
  switch (a.kind) {
    case 'schedule': {
      const mode = String(c.mode ?? '?')
      if (mode === 'at') return `once at ${String(c.at ?? '?')}`
      if (mode === 'every') return `every ${String(c.every ?? '?')}`
      if (mode === 'cron') return `${String(c.cron ?? '?')}${c.tz ? ` · ${c.tz}` : ''}`
      return mode
    }
    case 'hook': return `on ${c.event ?? '?'}`
    case 'webhook': return c.slug ? `/hook/${c.slug}` : '(slug pending)'
    default: return ''
  }
}

function classifyRunError(r: AutomationAuditRun): { msg: string; actionType: string; actionLabel?: string } {
  const err = r.error ?? ''
  const toolCalls = Array.isArray(r.toolCalls) ? (r.toolCalls as ToolCallRecord[]) : []
  const denied = toolCalls.filter(tc =>
    tc.error?.toLowerCase().includes('denied') ||
    tc.error?.toLowerCase().includes('permission') ||
    tc.error?.toLowerCase().includes('blocked')
  )
  if (denied.length > 0) {
    const toolName = denied[0].tool ?? ''
    const appId = toolName.split('_')[0]
    return { msg: `Tool denied: ${toolName}`, actionType: 'reconnect_app', actionLabel: appId ? `Connect ${appId}` : 'Check Settings' }
  }
  if (err.includes('No model configured')) return { msg: 'No AI model selected', actionType: 'configure_model', actionLabel: 'Settings → Agents' }
  if (err.includes('timed out')) return { msg: 'Question timed out', actionType: 'retry', actionLabel: 'Retry' }
  if (err.includes('not found') || err.includes('404')) return { msg: err, actionType: 'edit_prompt', actionLabel: 'Edit Prompt' }
  return { msg: err, actionType: 'other' }
}

// ─── ScheduleInput ───────────────────────────────────────────────────────────

const ScheduleInput: React.FC<{
  kind: AutomationKind
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}> = ({ kind, config, onChange }) => {
  const [nlText, setNlText] = useState('')
  const [nlDesc, setNlDesc] = useState<string | null>(null)

  if (kind === 'hook') {
    const cur = String(config.event ?? '')
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {HOOK_EVENTS.map(e => (
            <button key={e.value} type="button" onClick={() => onChange({ event: e.value })}
              className={cn('rounded px-2.5 py-1 text-xs font-medium transition',
                cur === e.value ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200')}>
              {e.label}
            </button>
          ))}
        </div>
        {cur && <div className="font-mono text-[11px] text-zinc-500">on {cur}</div>}
      </div>
    )
  }

  if (kind === 'webhook') {
    return <div className="rounded bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">Webhook URL is auto-generated on creation.</div>
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {SCHEDULE_PRESETS.map(p => {
          const active = config.cron === (p.config as Record<string, unknown>).cron && config.mode === (p.config as Record<string, unknown>).mode
          return (
            <button key={p.label} type="button" onClick={() => { onChange(p.config); setNlText(''); setNlDesc(null) }}
              className={cn('rounded px-2.5 py-1 text-xs font-medium transition',
                active ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200')}>
              {p.label}
            </button>
          )
        })}
      </div>
      <input type="text" value={nlText}
        onChange={e => {
          const v = e.target.value; setNlText(v)
          const parsed = parseNL(v)
          if (parsed) { setNlDesc(parsed.desc); onChange(parsed.config) } else { setNlDesc(null) }
        }}
        placeholder="e.g. every day at 9am, or 0 9 * * 1-5"
        className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
      />
      {(nlDesc || !!config.cron || !!config.every) && (
        <div className="font-mono text-[11px] text-zinc-500">
          {nlDesc && <span className="text-blue-400 mr-2">{nlDesc}</span>}
          {config.mode === 'cron' && config.cron ? <span>cron: {String(config.cron)}</span> : null}
          {config.mode === 'every' && config.every ? <span>every: {String(config.every)}</span> : null}
          {config.mode === 'at' && config.at ? <span>at: {String(config.at)}</span> : null}
          {config.tz ? <span> · {String(config.tz)}</span> : null}
        </div>
      )}
    </div>
  )
}

// ─── ToolsSelector ───────────────────────────────────────────────────────────

const ToolsSelector: React.FC<{
  allowed: string[]
  onChange: (tools: string[]) => void
}> = ({ allowed, onChange }) => {
  const [restricted, setRestricted] = useState(allowed.length > 0)
  const [tools, setTools] = useState<ToolMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')

  const enableRestrict = async () => {
    setRestricted(true)
    if (!loaded) {
      setLoading(true)
      try {
        const list = await window.wos.automations.listTools()
        setTools(list)
        setLoaded(true)
      } catch { /* ignore */ } finally { setLoading(false) }
    }
  }

  const filteredTools = useMemo(() => {
    if (!search) return tools
    const q = search.toLowerCase()
    return tools.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
  }, [tools, search])

  const groups = useMemo(() => {
    const builtIn: ToolMeta[] = [], byApp: Record<string, ToolMeta[]> = {}, mcp: ToolMeta[] = []
    for (const t of filteredTools) {
      if (t.name.startsWith('mcp__')) { mcp.push(t); continue }
      const appTag = t.tags.find(tag => tag.startsWith('apps:'))
      if (appTag) { const app = appTag.slice(5); (byApp[app] ??= []).push(t) }
      else builtIn.push(t)
    }
    return { builtIn, byApp, mcp }
  }, [filteredTools])

  const toggle = (name: string) =>
    onChange(allowed.includes(name) ? allowed.filter(t => t !== name) : [...allowed, name])

  return (
    <div className="space-y-2">
      <div className="flex gap-4 text-xs">
        {(['all', 'restrict'] as const).map(opt => (
          <label key={opt} className="flex cursor-pointer items-center gap-1.5">
            <input type="radio" checked={opt === 'all' ? !restricted : restricted}
              onChange={() => opt === 'all' ? (setRestricted(false), onChange([])) : enableRestrict()}
              className="accent-violet-500" />
            <span className={cn(opt === 'all' ? (!restricted ? 'text-zinc-100' : 'text-zinc-400') : (restricted ? 'text-zinc-100' : 'text-zinc-400'))}>
              {opt === 'all' ? 'All tools (recommended)' : 'Restrict to specific tools'}
            </span>
          </label>
        ))}
      </div>
      {restricted && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
          <div className="border-b border-zinc-800 p-2">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search tools…"
              className="w-full bg-transparent text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none" />
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-zinc-500" /></div>
          ) : (
            <div className="max-h-48 overflow-y-auto p-2 space-y-2">
              {groups.builtIn.length > 0 && <ToolGroup label="Built-in" tools={groups.builtIn} allowed={allowed} onToggle={toggle} />}
              {Object.entries(groups.byApp).map(([app, ts]) => (
                <ToolGroup key={app} label={app.charAt(0).toUpperCase() + app.slice(1)} tools={ts} allowed={allowed} onToggle={toggle} />
              ))}
              {groups.mcp.length > 0 && <ToolGroup label="MCP" tools={groups.mcp} allowed={allowed} onToggle={toggle} />}
            </div>
          )}
          {allowed.length > 0 && (
            <div className="border-t border-zinc-800 px-2 py-1.5 text-[11px] text-zinc-500">
              {allowed.length} tool{allowed.length > 1 ? 's' : ''} selected
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ToolGroup: React.FC<{
  label: string; tools: ToolMeta[]; allowed: string[]; onToggle: (name: string) => void
}> = ({ label, tools, allowed, onToggle }) => {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 py-0.5 text-[11px] font-semibold text-zinc-500 hover:text-zinc-300">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && (
        <div className="ml-3 mt-1 space-y-1">
          {tools.map(t => (
            <label key={t.name} className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" checked={allowed.includes(t.name)} onChange={() => onToggle(t.name)} className="mt-0.5 accent-violet-500" />
              <div>
                <div className="font-mono text-[11px] text-zinc-200">{t.name}</div>
                <div className="text-[10px] text-zinc-500 leading-tight">{t.description}</div>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── AutomationWizardModal ───────────────────────────────────────────────────

const AutomationWizardModal: React.FC<{
  onClose: () => void
  onCreated: () => void
}> = ({ onClose, onCreated }) => {
  const [stage, setStage] = useState<WizardStage>('idle')
  const [description, setDescription] = useState('')
  const [parsed, setParsed] = useState<AutomationParsedSpec | null>(null)
  const [clarifications, setClarifications] = useState<AutomationClarification[]>([])
  const [clarAnswers, setClarAnswers] = useState<Record<string, string>>({})
  const [missingApps, setMissingApps] = useState<Array<{ appId: string; name: string }>>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [editedName, setEditedName] = useState('')
  const [editedPrompt, setEditedPrompt] = useState('')
  const [editedConfig, setEditedConfig] = useState<Record<string, unknown>>({})
  const [editedDelivery, setEditedDelivery] = useState<ResultDelivery>('chat')
  const [editedTools, setEditedTools] = useState<string[]>([])
  const [editedKind, setEditedKind] = useState<AutomationKind>('schedule')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (stage === 'idle') textareaRef.current?.focus() }, [stage])

  const initConfig = (spec: AutomationParsedSpec) => {
    setEditedName(spec.name)
    setEditedPrompt(spec.prompt)
    setEditedKind(spec.kind)
    setEditedConfig(spec.schedule ?? spec.hook ?? spec.webhook ?? {})
    setEditedDelivery((spec.delivery?.kind as ResultDelivery | undefined) ?? 'chat')
    setEditedTools([])
  }

  const handleGenerate = async () => {
    if (!description.trim()) return
    setStage('generating'); setParseError(null)
    try {
      const result = await window.wos.automations.parseDescription(description.trim())
      if (!result.ok || !result.spec) { setParseError(result.error ?? 'Failed to analyze'); setStage('idle'); return }
      setParsed(result.spec); setMissingApps(result.missingApps ?? [])
      if (result.clarifications && result.clarifications.length > 0) {
        setClarifications(result.clarifications); setClarAnswers({}); setStage('clarifying')
      } else {
        initConfig(result.spec); setStage('configuring')
      }
    } catch (err) { setParseError((err as Error).message); setStage('idle') }
  }

  const handleApplyClarifications = () => {
    if (!parsed) return
    let prompt = parsed.prompt
    for (const c of clarifications) {
      const ans = clarAnswers[c.key]
      if (ans) prompt = prompt.replace(`[${c.key}]`, ans)
    }
    const resolved = { ...parsed, prompt }
    setParsed(resolved); initConfig(resolved); setStage('configuring')
  }

  const handleReanalyze = async () => {
    if (!editedPrompt.trim()) return
    setStage('generating')
    try {
      const result = await window.wos.automations.parseDescription(editedPrompt.trim())
      if (result.ok && result.spec) { initConfig(result.spec); setMissingApps(result.missingApps ?? []) }
    } catch { /* ignore */ } finally { setStage('configuring') }
  }

  const handleCreate = async () => {
    if (!editedName.trim()) return
    setStage('creating')
    try {
      await window.wos.automations.upsert({
        name: editedName, kind: editedKind, prompt: editedPrompt, enabled: true,
        toolsAllow: editedTools, config: editedConfig, resultDelivery: editedDelivery,
      })
      toast.success(`Automation "${editedName}" created`)
      onCreated(); onClose()
    } catch (err) { toast.error(`Failed to create: ${(err as Error).message}`); setStage('configuring') }
  }

  const clarComplete = clarifications.every(c => !!clarAnswers[c.key])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-400" />
            <h2 className="text-sm font-semibold text-zinc-100">
              {stage === 'clarifying' ? 'A few details…' : stage === 'configuring' || stage === 'creating' ? 'Configure Automation' : 'Create Automation'}
            </h2>
            {stage === 'configuring' && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> Analyzed
              </span>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
            <XCircle className="h-4 w-4" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Stage: idle / generating */}
          {(stage === 'idle' || stage === 'generating') && <>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">What should WOS do?</label>
              <textarea ref={textareaRef} value={description} rows={3}
                onChange={e => { setDescription(e.target.value); setParseError(null) }}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate() }}
                placeholder="e.g. Post a daily summary of #engineering on Slack every weekday at 9am"
                className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-zinc-600">Tip: ⌘↵ to generate</p>
            </div>
            {parseError && <div className="rounded-lg bg-rose-950/40 px-3 py-2 text-xs text-rose-300">{parseError}</div>}
          </>}

          {/* Stage: clarifying */}
          {stage === 'clarifying' && (
            <div className="space-y-5">
              <p className="text-xs text-zinc-400">Your automation needs a few more details to run correctly.</p>
              {clarifications.map(clar => (
                <div key={clar.key} className="space-y-1.5">
                  <label className="block text-xs font-medium text-zinc-300">{clar.question}</label>
                  {clar.kind === 'choice' && clar.choices && clar.choices.length > 0 ? (
                    <div className="space-y-1">
                      {clar.choices.map(choice => (
                        <label key={choice.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 hover:border-zinc-700">
                          <input type="radio" name={clar.key} value={choice.value}
                            checked={clarAnswers[clar.key] === choice.value}
                            onChange={() => setClarAnswers(p => ({ ...p, [clar.key]: choice.value }))}
                            className="mt-0.5 accent-violet-500" />
                          <div>
                            <div className="text-xs text-zinc-200">{choice.label}</div>
                            {choice.description && <div className="text-[10px] text-zinc-500">{choice.description}</div>}
                          </div>
                        </label>
                      ))}
                      {clar.allowFreeform && (
                        <label className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 hover:border-zinc-700">
                          <input type="radio" name={clar.key}
                            checked={!!clarAnswers[clar.key] && !clar.choices!.some(c => c.value === clarAnswers[clar.key])}
                            onChange={() => setClarAnswers(p => ({ ...p, [clar.key]: '' }))}
                            className="accent-violet-500" />
                          <input type="text" placeholder="Type custom value…"
                            value={(!clar.choices!.some(c => c.value === clarAnswers[clar.key]) ? clarAnswers[clar.key] : '') ?? ''}
                            onChange={e => setClarAnswers(p => ({ ...p, [clar.key]: e.target.value }))}
                            onClick={() => { if (clar.choices!.some(c => c.value === (clarAnswers[clar.key] ?? ''))) setClarAnswers(p => ({ ...p, [clar.key]: '' })) }}
                            className="flex-1 bg-transparent text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none" />
                        </label>
                      )}
                    </div>
                  ) : (
                    <input type="text" value={clarAnswers[clar.key] ?? ''}
                      onChange={e => setClarAnswers(p => ({ ...p, [clar.key]: e.target.value }))}
                      placeholder={clar.placeholder}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none" />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Stage: configuring */}
          {stage === 'configuring' && parsed && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Name</label>
                <input type="text" value={editedName} onChange={e => setEditedName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none" />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Prompt</label>
                  <button type="button" onClick={handleReanalyze} className="flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300">
                    <Sparkles className="h-3 w-3" /> Re-analyze
                  </button>
                </div>
                <textarea value={editedPrompt} onChange={e => setEditedPrompt(e.target.value)} rows={4}
                  className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 font-mono text-[12px] text-zinc-100 focus:border-violet-500 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  Trigger <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] normal-case font-normal capitalize">{editedKind}</span>
                </label>
                <ScheduleInput kind={editedKind} config={editedConfig} onChange={setEditedConfig} />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Result Delivery</label>
                <div className="flex flex-wrap gap-1.5">
                  {DELIVERY_OPTIONS.map(d => (
                    <button key={d.value} type="button" onClick={() => setEditedDelivery(d.value)} title={d.description}
                      className={cn('rounded px-2.5 py-1 text-xs font-medium transition',
                        editedDelivery === d.value ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200')}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Tools</label>
                <ToolsSelector allowed={editedTools} onChange={setEditedTools} />
              </div>
              {parsed.summary.length > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">What this automation does</div>
                  {parsed.summary.map((line, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-zinc-400">
                      <span className="mt-0.5 shrink-0 text-violet-400">•</span>{line}
                    </div>
                  ))}
                </div>
              )}
              {missingApps.length > 0 && (
                <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Apps not yet connected
                  </div>
                  {missingApps.map(app => (
                    <div key={app.appId} className="text-xs text-amber-400">
                      {app.name} — connect in Settings › Apps. Automation will fail until connected.
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {stage === 'creating' && (
            <div className="flex items-center justify-center gap-2 py-8 text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /><span className="text-sm">Creating automation…</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          <div>
            {stage === 'clarifying' && (
              <button onClick={() => setStage('idle')} className="text-xs text-zinc-500 hover:text-zinc-300">← Back</button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">Cancel</button>
            {(stage === 'idle' || stage === 'generating') && (
              <button onClick={handleGenerate} disabled={!description.trim() || stage === 'generating'}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                {stage === 'generating'
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing…</>
                  : <><Sparkles className="h-3.5 w-3.5" /> Generate Config</>}
              </button>
            )}
            {stage === 'clarifying' && (
              <button onClick={handleApplyClarifications} disabled={!clarComplete}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                <ChevronRight className="h-3.5 w-3.5" /> Apply & Configure
              </button>
            )}
            {stage === 'configuring' && (
              <button onClick={handleCreate} disabled={!editedName.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40">
                <CheckCircle2 className="h-3.5 w-3.5" /> Create Automation
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

// ─── RunRow ──────────────────────────────────────────────────────────────────

const RunRow: React.FC<{ r: AutomationAuditRun; automationId: string; onEditPrompt?: () => void }> = ({ r, automationId, onEditPrompt }) => {
  const [open, setOpen] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<{ explanation: string; suggestions: string[]; actionType: string } | null>(null)

  const toolCalls = useMemo(() => Array.isArray(r.toolCalls) ? (r.toolCalls as ToolCallRecord[]) : [], [r.toolCalls])
  const denied = useMemo(() => toolCalls.filter(tc => tc.error?.toLowerCase().match(/denied|permission|blocked/)), [toolCalls])
  const { msg: errMsg, actionLabel } = useMemo(() => classifyRunError(r), [r])

  const statusColor = r.status === 'success' ? 'text-emerald-400' : r.status === 'error' ? 'text-rose-400'
    : r.status === 'running' ? 'text-blue-400' : r.status === 'dryrun' ? 'text-cyan-400' : 'text-zinc-500'
  const StatusIcon = r.status === 'success' ? CheckCircle2 : r.status === 'error' ? AlertCircle
    : r.status === 'running' ? Loader2 : r.status === 'dryrun' ? CheckCircle2 : XCircle

  const handleDiagnose = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setDiagnosing(true)
    try {
      const result = await window.wos.automations.diagnoseRun(r.id)
      if (result.ok && result.explanation) {
        setDiagnosis({ explanation: result.explanation, suggestions: result.suggestions ?? [], actionType: result.actionType ?? 'other' })
      }
    } catch { /* ignore */ } finally { setDiagnosing(false) }
  }

  return (
    <li>
      <button onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-zinc-900/80">
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusColor, r.status === 'running' && 'animate-spin')} />
        <span className={cn('font-mono', statusColor)}>{r.status}</span>
        {denied.length > 0 && (
          <span className="rounded bg-rose-950/60 px-1.5 py-0.5 text-[10px] text-rose-300">
            {denied.length} denied
          </span>
        )}
        <span className="text-zinc-500">{formatRelative(r.startedAt)}</span>
        <span className="ml-auto text-zinc-600">{new Date(r.startedAt).toLocaleTimeString()}</span>
        {r.status === 'error' && (
          <button onClick={handleDiagnose} disabled={diagnosing}
            className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
            title="AI diagnosis">
            {diagnosing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3 text-violet-400" />}
            Diagnose
          </button>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-900 bg-zinc-950 px-3 py-2 text-[11px]">
          {r.error && !diagnosis && (
            <div className="space-y-1.5 rounded bg-rose-950/40 p-2">
              <pre className="whitespace-pre-wrap text-rose-300">{errMsg || r.error}</pre>
              {actionLabel && onEditPrompt && (
                <button onClick={onEditPrompt}
                  className="flex items-center gap-1 rounded bg-rose-900/50 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-900/80">
                  <Edit2 className="h-3 w-3" /> {actionLabel}
                </button>
              )}
            </div>
          )}
          {diagnosis && (
            <div className="rounded bg-zinc-900 p-2 space-y-1.5 border border-zinc-800">
              <div className="flex items-center gap-1 text-violet-400 font-semibold"><Sparkles className="h-3 w-3" /> AI Diagnosis</div>
              <p className="text-zinc-300 leading-relaxed">{diagnosis.explanation}</p>
              {diagnosis.suggestions.map((s, i) => (
                <div key={i} className="flex items-start gap-1 text-zinc-400">
                  <span className="text-violet-400 shrink-0">•</span>{s}
                </div>
              ))}
              {(diagnosis.actionType === 'edit_prompt' || diagnosis.actionType === 'other') && onEditPrompt && (
                <button onClick={onEditPrompt}
                  className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700">
                  <Edit2 className="h-3 w-3" /> Edit Prompt
                </button>
              )}
            </div>
          )}
          {denied.length > 0 && (
            <div className="rounded bg-rose-950/30 p-2 text-rose-300">
              <div className="mb-1 font-semibold">Denied tools:</div>
              {denied.map((tc, i) => <div key={i} className="font-mono">{tc.tool}{tc.error ? ` — ${tc.error}` : ''}</div>)}
              <div className="mt-1 text-zinc-400">Connect required apps in Settings › Apps.</div>
            </div>
          )}
          {r.output && <pre className="whitespace-pre-wrap rounded bg-zinc-900/60 p-2 text-zinc-300">{r.output}</pre>}
          {toolCalls.length > 0 && !denied.length && (
            <div className="text-zinc-600">
              {toolCalls.length} tool call{toolCalls.length > 1 ? 's' : ''}: {toolCalls.map(tc => tc.tool).join(', ')}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

// ─── LiveProgress ─────────────────────────────────────────────────────────────

interface LiveEvent {
  type: string
  toolName?: string
  content?: string
  result?: unknown
  error?: string
  status?: string
}

const LiveProgress: React.FC<{ events: LiveEvent[]; done: boolean; startedAt: number }> = ({ events, done, startedAt }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events])
  const elapsed = done ? null : Math.round((Date.now() - startedAt) / 1000)

  const accumulatedText = events
    .filter(ev => ev.type === 'text_delta' && ev.content)
    .map(ev => ev.content!)
    .join('')
  const firstTextIdx = events.findIndex(ev => ev.type === 'text_delta')

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      {/* sticky header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-950">
        {done
          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />}
        <span className="text-xs font-medium text-zinc-300">{done ? 'Completed' : 'Running…'}</span>
        {elapsed !== null && <span className="text-[11px] text-zinc-500">{elapsed}s</span>}
        {done && accumulatedText && (
          <button
            onClick={() => { void navigator.clipboard.writeText(accumulatedText); toast.success('Copied!', { duration: 1500 }) }}
            className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Copy output"
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
      {/* scrollable event list — capped at 288px so it never breaks layout */}
      <div ref={scrollRef} className="overflow-y-auto max-h-72 p-3 space-y-1">
        {events.map((ev, i) => {
          if (ev.type === 'tool_use_start') return (
            <div key={i} className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-400">
              <span className="text-violet-400">▶</span>{ev.toolName}
            </div>
          )
          if (ev.type === 'tool_result') return (
            <div key={i} className="ml-4 text-[11px] text-zinc-500 font-mono truncate">
              └─ {ev.error ? <span className="text-rose-400">{ev.error}</span> : <span className="text-zinc-400">done</span>}
            </div>
          )
          if (ev.type === 'text_delta') {
            if (i === firstTextIdx && accumulatedText) {
              return (
                <div key={i} className="mt-1 border-t border-zinc-800 pt-2">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    className="prose prose-invert prose-sm max-w-none text-[11px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  >
                    {accumulatedText}
                  </ReactMarkdown>
                </div>
              )
            }
            return null
          }
          if (ev.type === 'run_complete') return (
            <div key={i} className={cn('text-[11px] font-medium', ev.status === 'error' ? 'text-rose-400' : 'text-emerald-400')}>
              {ev.status === 'error' ? `✗ ${ev.error ?? 'Failed'}` : '✓ Done'}
            </div>
          )
          return null
        })}
      </div>
    </div>
  )
}

// ─── PendingQuestionCard ──────────────────────────────────────────────────────

const PendingQuestionCard: React.FC<{
  q: PendingQuestion
  onAnswer: (questionId: string, answer: string) => void
}> = ({ q, onAnswer }) => {
  const [custom, setCustom] = useState('')
  const [answering, setAnswering] = useState(false)

  const answer = async (val: string) => {
    setAnswering(true)
    try { await onAnswer(q.questionId, val) } catch { /* ignore */ } finally { setAnswering(false) }
  }

  return (
    <div className="rounded-lg border border-violet-800/60 bg-violet-950/30 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-300">
        <MessageSquare className="h-3.5 w-3.5 shrink-0" /> Waiting for your input
      </div>
      <p className="text-xs text-zinc-200">{q.question}</p>
      {q.choices && q.choices.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {q.choices.map(c => (
            <button key={c} onClick={() => answer(c)} disabled={answering}
              className="rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50">
              {c}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2">
          <input type="text" value={custom} onChange={e => setCustom(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) answer(custom.trim()) }}
            placeholder="Type your answer…"
            className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none" />
          <button onClick={() => answer(custom.trim())} disabled={!custom.trim() || answering}
            className="rounded bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-500 disabled:opacity-50">
            Send
          </button>
        </div>
      )}
    </div>
  )
}

// ─── DetailPane ───────────────────────────────────────────────────────────────

const DetailPane: React.FC<{
  a: AutomationRow
  runs: AutomationAuditRun[]
  busy: boolean
  pendingQuestion: PendingQuestion | null
  liveEvents: LiveEvent[]
  liveRunActive: boolean
  liveStartedAt: number
  onClose: () => void
  onToggle: () => void
  onDelete: () => void
  onRun: () => void
  onDryRun: () => void
  onSaved: (a: AutomationRow) => void
  onAnswerQuestion: (questionId: string, answer: string) => void
}> = ({ a, runs, busy, pendingQuestion, liveEvents, liveRunActive, liveStartedAt, onClose, onToggle, onDelete, onRun, onDryRun, onSaved, onAnswerQuestion }) => {
  const meta = KIND_META[a.kind]
  const Icon = meta.icon
  const [webhookInfo, setWebhookInfo] = useState<{ slug: string; localUrl: string; publicUrl: string | null } | null>(null)
  const [editing, setEditing] = useState(false)
  const [editPrompt, setEditPrompt] = useState(a.prompt)
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>(a.config)
  const [editDelivery, setEditDelivery] = useState<ResultDelivery>(a.resultDelivery)
  const [editTools, setEditTools] = useState<string[]>(a.toolsAllow)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (a.kind === 'webhook') {
      window.wos.automations.webhookInfo(a.id).then(info => {
        if (info) setWebhookInfo({ slug: info.slug, localUrl: info.localUrl, publicUrl: info.publicUrl })
      }).catch(() => {})
    }
  }, [a.id, a.kind])

  const startEdit = () => {
    setEditPrompt(a.prompt); setEditConfig(a.config)
    setEditDelivery(a.resultDelivery); setEditTools(a.toolsAllow)
    setEditing(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await window.wos.automations.upsert({
        id: a.id, name: a.name, kind: a.kind,
        prompt: editPrompt, config: editConfig,
        resultDelivery: editDelivery, toolsAllow: editTools,
        enabled: a.enabled,
      })
      onSaved(updated); setEditing(false)
      toast.success('Automation updated')
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally { setSaving(false) }
  }

  const handleRegenConfig = async () => {
    if (!editPrompt.trim()) return
    try {
      const result = await window.wos.automations.parseDescription(editPrompt.trim())
      if (result.ok && result.spec) {
        setEditConfig(result.spec.schedule ?? result.spec.hook ?? result.spec.webhook ?? {})
        setEditDelivery((result.spec.delivery?.kind as ResultDelivery | undefined) ?? 'chat')
        toast.success('Config regenerated from prompt')
      }
    } catch { /* ignore */ }
  }

  const showLive = liveRunActive || (liveEvents.length > 0 && liveEvents[liveEvents.length - 1]?.type === 'run_complete')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800/80 px-6 py-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-zinc-900 p-2"><Icon className={cn('h-5 w-5', meta.color)} /></div>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">{a.name}</h2>
            <div className="mt-0.5 text-xs text-zinc-500">
              {meta.label} · <span className="font-mono">{describeConfig(a)}</span>
              {!a.enabled && <span className="ml-2 rounded bg-amber-900/30 px-1.5 py-0.5 text-[10px] text-amber-400">paused</span>}
            </div>
          </div>
        </div>
        <button onClick={onClose} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800"><XCircle className="h-4 w-4" /></button>
      </header>

      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-6 py-2.5">
        <button onClick={onToggle} disabled={busy}
          className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700">
          {a.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {a.enabled ? 'Pause' : 'Enable'}
        </button>
        <button onClick={onRun} disabled={busy}
          className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700">
          <Zap className="h-3.5 w-3.5" /> Run now
        </button>
        <button onClick={onDryRun} disabled={busy}
          className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Dry run
        </button>
        {!editing ? (
          <button onClick={startEdit}
            className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700">
            <Edit2 className="h-3.5 w-3.5" /> Edit
          </button>
        ) : (
          <>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
            </button>
            <button onClick={() => setEditing(false)}
              className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700">
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          </>
        )}
        <div className="flex-1" />
        <button onClick={onDelete} disabled={busy}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-rose-400 hover:bg-rose-900/30">
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Pending question */}
        {pendingQuestion && (
          <section className="mb-5">
            <PendingQuestionCard q={pendingQuestion} onAnswer={onAnswerQuestion} />
          </section>
        )}

        {/* Live progress */}
        {showLive && (
          <section className="mb-5">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Live Run</h3>
            <LiveProgress events={liveEvents} done={!liveRunActive} startedAt={liveStartedAt} />
          </section>
        )}

        {/* Webhook info */}
        {webhookInfo && (
          <SectionBlock title="Webhook URLs">
            <div className="space-y-2 rounded-md bg-zinc-900/60 p-3 text-xs">
              <Field label="Local" value={webhookInfo.localUrl} />
              <Field label="Public" value={webhookInfo.publicUrl ?? '(tunnel offline)'} />
              <Field label="Slug" value={webhookInfo.slug} />
            </div>
          </SectionBlock>
        )}

        {/* Prompt */}
        <SectionBlock title="Prompt">
          {editing ? (
            <div className="space-y-2">
              <textarea value={editPrompt} onChange={e => setEditPrompt(e.target.value)} rows={6}
                className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 font-mono text-[12px] text-zinc-100 focus:border-violet-500 focus:outline-none" />
              <button onClick={handleRegenConfig}
                className="flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300">
                <Sparkles className="h-3 w-3" /> Re-generate Config from prompt
              </button>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap rounded-md bg-zinc-900/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
              {a.prompt || '(empty)'}
            </pre>
          )}
        </SectionBlock>

        {/* Trigger config */}
        <SectionBlock title="Trigger">
          {editing ? (
            <ScheduleInput kind={a.kind} config={editConfig} onChange={setEditConfig} />
          ) : (
            <pre className="whitespace-pre-wrap rounded-md bg-zinc-900/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
              {JSON.stringify(a.config, null, 2)}
            </pre>
          )}
        </SectionBlock>

        {/* Delivery */}
        <SectionBlock title="Result Delivery">
          {editing ? (
            <div className="flex flex-wrap gap-1.5">
              {DELIVERY_OPTIONS.map(d => (
                <button key={d.value} type="button" onClick={() => setEditDelivery(d.value)} title={d.description}
                  className={cn('rounded px-2.5 py-1 text-xs font-medium transition',
                    editDelivery === d.value ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200')}>
                  {d.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-xs text-zinc-300">
              <span className="font-mono">{a.resultDelivery}</span>
              {a.resultTarget && <span className="ml-2 text-zinc-500">→ {a.resultTarget}</span>}
            </div>
          )}
        </SectionBlock>

        {/* Tools */}
        <SectionBlock title="Tools">
          {editing ? (
            <ToolsSelector allowed={editTools} onChange={setEditTools} />
          ) : (
            <div className="flex flex-wrap gap-1">
              {a.toolsAllow.length === 0
                ? <span className="text-xs italic text-zinc-500">All available tools (unrestricted)</span>
                : a.toolsAllow.map(t => (
                  <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{t}</span>
                ))}
            </div>
          )}
        </SectionBlock>

        {/* Recent runs */}
        <SectionBlock title={`Recent runs (${runs.length})`}>
          {runs.length === 0
            ? <div className="text-xs text-zinc-500">No runs yet.</div>
            : (
              <ul className="divide-y divide-zinc-900 rounded-md bg-zinc-900/40">
                {runs.map(r => <RunRow key={r.id} r={r} automationId={a.id} onEditPrompt={startEdit} />)}
              </ul>
            )}
        </SectionBlock>
      </div>
    </div>
  )
}

const SectionBlock: React.FC<React.PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <section className="mb-5">
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
    {children}
  </section>
)

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline gap-2">
    <span className="w-12 shrink-0 text-zinc-500">{label}</span>
    <span className="break-all font-mono text-zinc-200">{value}</span>
  </div>
)

// ─── AutomationRow ────────────────────────────────────────────────────────────

const AutomationRowItem: React.FC<{
  a: AutomationRow; busy: boolean; selected: boolean
  hasPendingQuestion: boolean
  onClick: () => void; onToggle: () => void; onRun: () => void
}> = ({ a, busy, selected, hasPendingQuestion, onClick, onToggle, onRun }) => {
  const meta = KIND_META[a.kind]; const Icon = meta.icon
  return (
    <li>
      <button onClick={onClick}
        className={cn('group flex w-full items-start gap-3 border-b border-zinc-900/80 px-4 py-3 text-left transition',
          selected ? 'bg-zinc-900' : 'hover:bg-zinc-900/60')}>
        <div className={cn('mt-0.5 rounded-md bg-zinc-900 p-1.5', selected && 'bg-zinc-800')}>
          <Icon className={cn('h-4 w-4', meta.color)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">{a.name}</span>
            {!a.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">paused</span>}
            {hasPendingQuestion && <span className="rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] text-violet-300">needs input</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            <span className="text-zinc-400">{meta.label}</span>
            <span className="mx-1 text-zinc-700">·</span>
            <span className="font-mono text-[11px]">{describeConfig(a)}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-zinc-600">
            <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> last {formatRelative(a.lastRunAt)}</span>
            {a.nextRunAt && <span className="inline-flex items-center gap-1"><ChevronRight className="h-3 w-3" /> next {formatRelative(a.nextRunAt)}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 opacity-0 transition group-hover:opacity-100">
          <button onClick={e => { e.stopPropagation(); onToggle() }} disabled={busy}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title={a.enabled ? 'Pause' : 'Enable'}>
            {a.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button onClick={e => { e.stopPropagation(); onRun() }} disabled={busy}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Run now">
            <Zap className="h-3.5 w-3.5" />
          </button>
        </div>
      </button>
    </li>
  )
}

// ─── EmptyStates ──────────────────────────────────────────────────────────────

const EmptyState: React.FC<{ section: Section; onNew: () => void }> = ({ section, onNew }) => {
  const copy = section === 'schedule' ? { title: 'No schedules', sub: 'Intervals, cron jobs, and one-shot reminders.' }
    : section === 'hook' ? { title: 'No event hooks', sub: 'Trigger on meeting saved, session started, and more.' }
    : section === 'webhook' ? { title: 'No webhooks', sub: 'Trigger from external services via HTTPS POST.' }
    : { title: 'No automations yet', sub: 'Schedules, event hooks, and webhooks live here.' }
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <SettingsIcon className="mb-3 h-6 w-6 text-zinc-700" />
      <h3 className="text-sm font-medium text-zinc-300">{copy.title}</h3>
      <p className="mt-1 max-w-xs text-xs text-zinc-500">{copy.sub}</p>
      <button onClick={onNew}
        className="mt-4 flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700">
        <Plus className="h-3.5 w-3.5" /> Create automation
      </button>
    </div>
  )
}

const DetailEmptyState: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
    <Globe className="mb-3 h-8 w-8 text-zinc-800" />
    <h3 className="text-sm font-medium text-zinc-400">Select an automation</h3>
    <p className="mt-1 max-w-md text-xs text-zinc-600">Pick one from the left to see its config, run history, and controls.</p>
  </div>
)

// ─── AutomationsView (main) ───────────────────────────────────────────────────

export const AutomationsView: React.FC = () => {
  const [section, setSection] = useState<Section>('all')
  const [items, setItems] = useState<AutomationRow[]>([])
  const [selected, setSelected] = useState<AutomationRow | null>(null)
  const [runs, setRuns] = useState<AutomationAuditRun[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, PendingQuestion>>({})
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([])
  const [liveRunActive, setLiveRunActive] = useState(false)
  const [liveStartedAt, setLiveStartedAt] = useState(0)
  const [liveAutomationId, setLiveAutomationId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setItems(await window.wos.automations.list()) }
    catch (err) { toast.error(`Failed to load: ${(err as Error).message}`) }
    finally { setLoading(false) }
  }, [])

  const refreshRuns = useCallback(async (id: string) => {
    try { setRuns(await window.wos.automations.runs(id, 50)) }
    catch { setRuns([]) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!selected) { setRuns([]); return }
    refreshRuns(selected.id)
  }, [selected, refreshRuns])

  // Subscribe to global IPC events
  useEffect(() => {
    const offError = window.wos.automations.onError(e => {
      toast.error(`Automation error: ${e.error}`, { description: `runId: ${e.runId}` })
      refresh()
    })
    const offResult = window.wos.automations.onResult(() => { refresh() })
    const offOpen = window.wos.automations.onOpen(e => {
      window.wos.automations.get(e.automationId).then(a => { if (a) setSelected(a) }).catch(() => {})
    })
    const offQuestion = window.wos.automations.onQuestion(e => {
      setPendingQuestions(prev => ({ ...prev, [e.automationId]: e as PendingQuestion }))
    })
    const offRunEvent = window.wos.automations.onRunEvent(e => {
      const ev = e.event as LiveEvent
      setLiveEvents(prev => [...prev, ev])
      if (ev.type === 'run_complete') {
        setLiveRunActive(false)
        if (liveAutomationId) refreshRuns(liveAutomationId)
        refresh()
      }
    })
    return () => { offError(); offResult(); offOpen(); offQuestion(); offRunEvent() }
  }, [refresh, refreshRuns, liveAutomationId])

  const filtered = useMemo(() => section === 'all' ? items : items.filter(i => i.kind === section), [items, section])
  const counts = useMemo(() => ({
    all: items.length,
    schedule: items.filter(i => i.kind === 'schedule').length,
    hook: items.filter(i => i.kind === 'hook').length,
    webhook: items.filter(i => i.kind === 'webhook').length,
  }), [items])

  const handleToggle = async (a: AutomationRow) => {
    setBusy(a.id)
    try {
      await window.wos.automations.toggle(a.id, !a.enabled)
      await refresh()
      if (selected?.id === a.id) setSelected(prev => prev ? { ...prev, enabled: !prev.enabled } : null)
    } catch (err) { toast.error(`Toggle failed: ${(err as Error).message}`) }
    finally { setBusy(null) }
  }

  const handleDelete = async (a: AutomationRow) => {
    if (!confirm(`Delete automation "${a.name}"? This cannot be undone.`)) return
    setBusy(a.id)
    try {
      await window.wos.automations.delete(a.id)
      if (selected?.id === a.id) setSelected(null)
      await refresh()
      toast.success(`Deleted "${a.name}"`)
    } catch (err) { toast.error(`Delete failed: ${(err as Error).message}`) }
    finally { setBusy(null) }
  }

  const handleRunNow = async (a: AutomationRow, dryRun = false) => {
    setBusy(a.id)
    setLiveEvents([]); setLiveRunActive(true); setLiveStartedAt(Date.now()); setLiveAutomationId(a.id)
    toast.loading(dryRun ? 'Dry run…' : 'Running…', { id: 'run-' + a.id })
    try {
      const r = await window.wos.automations.runNow(a.id, dryRun)
      if (r.ok) toast.success(dryRun ? 'Dry run complete' : 'Run complete', { id: 'run-' + a.id, description: r.output?.slice(0, 120) })
      else toast.error('Run failed', { id: 'run-' + a.id, description: r.error ?? '' })
      if (selected?.id === a.id) await refreshRuns(a.id)
      await refresh()
    } catch (err) { toast.error('Run failed', { id: 'run-' + a.id, description: (err as Error).message }) }
    finally { setBusy(null); setLiveRunActive(false) }
  }

  const handleAnswerQuestion = async (questionId: string, answer: string) => {
    const result = await window.wos.automations.answerQuestion(questionId, answer)
    setPendingQuestions(prev => {
      const next = { ...prev }
      for (const [k, q] of Object.entries(next)) { if (q.questionId === questionId) delete next[k] }
      return next
    })
    if (result?.promptUpdated) {
      toast.success("Prompt updated — won't ask this again!", { duration: 4000 })
      // Silently refresh list and re-fetch the selected automation so the prompt shows updated
      void window.wos.automations.list().then(setItems).catch(() => {})
      if (selected) {
        void window.wos.automations.get(selected.id).then(a => { if (a) setSelected(a) }).catch(() => {})
      }
    }
  }

  const handleSaved = (updated: AutomationRow) => {
    setSelected(updated)
    setItems(prev => prev.map(i => i.id === updated.id ? updated : i))
  }

  return (
    <div className="flex h-full w-full bg-zinc-950 text-zinc-100">
      {wizardOpen && (
        <AutomationWizardModal
          onClose={() => setWizardOpen(false)}
          onCreated={refresh}
        />
      )}

      {/* Left: list */}
      <div className="flex w-[420px] shrink-0 flex-col border-r border-zinc-800/80">
        <header className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-zinc-400" />
            <h1 className="text-sm font-semibold tracking-tight">Automations</h1>
            {Object.keys(pendingQuestions).length > 0 && (
              <span className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">
                {Object.keys(pendingQuestions).length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={refresh} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Refresh">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
            <button onClick={() => setWizardOpen(true)}
              className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700">
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
        </header>

        <nav className="flex gap-1 border-b border-zinc-800/80 px-2 py-2">
          {(['all', 'schedule', 'hook', 'webhook'] as const).map(id => (
            <button key={id} onClick={() => setSection(id)}
              className={cn('flex-1 rounded px-2 py-1.5 text-xs font-medium transition capitalize',
                section === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200')}>
              {id === 'all' ? 'All' : id === 'hook' ? 'Hooks' : id.charAt(0).toUpperCase() + id.slice(1) + 's'}
              <span className="ml-1 text-[10px] text-zinc-500">{counts[id]}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <EmptyState section={section} onNew={() => setWizardOpen(true)} />
          ) : (
            <ul>
              {filtered.map(a => (
                <AutomationRowItem key={a.id} a={a} busy={busy === a.id}
                  selected={selected?.id === a.id}
                  hasPendingQuestion={!!pendingQuestions[a.id]}
                  onClick={() => setSelected(a)}
                  onToggle={() => handleToggle(a)}
                  onRun={() => handleRunNow(a)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <DetailPane
            a={selected}
            runs={runs}
            busy={busy === selected.id}
            pendingQuestion={pendingQuestions[selected.id] ?? null}
            liveEvents={liveAutomationId === selected.id ? liveEvents : []}
            liveRunActive={liveAutomationId === selected.id && liveRunActive}
            liveStartedAt={liveStartedAt}
            onClose={() => setSelected(null)}
            onToggle={() => handleToggle(selected)}
            onDelete={() => handleDelete(selected)}
            onRun={() => handleRunNow(selected)}
            onDryRun={() => handleRunNow(selected, true)}
            onSaved={handleSaved}
            onAnswerQuestion={handleAnswerQuestion}
          />
        ) : (
          <DetailEmptyState />
        )}
      </div>
    </div>
  )
}

export default AutomationsView
