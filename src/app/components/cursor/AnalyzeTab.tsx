import React, { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertCircle, ArrowLeft, CheckCircle, ChevronRight, Clipboard, CloudDownload,
  Edit3, File, FileCode, FileText, Folder, FolderOpen, Hash, HelpCircle, Loader2,
  Mail, MessageSquare, Mic, RefreshCw, Search, Send, Trash2, Upload, Video, X, Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../../lib/utils'

interface DriveFile {
  id: string
  name: string
  displayName: string
  date: string
  mimeType: string
  size: number
  webViewLink?: string
  fileCategory: 'video' | 'audio' | 'transcript' | 'document'
  hasTranscript: boolean
  transcriptFileId?: string
  transcriptName?: string
}

type DriveRecording = DriveFile

interface DriveFolder {
  id: string
  name: string
  modifiedTime?: string
}

interface MeetingResult {
  summary: string
  actionItems: Array<{ owner?: string | null; task: string; dueDate?: string | null }>
  decisions: Array<{ decision: string; context?: string | null }>
  openQuestions: string[]
}

type MeetingStatus = 'queued' | 'reading' | 'transcribing' | 'analyzing' | 'done' | 'error' | 'interrupted'
type AnalyzeMode = 'home' | 'detail'
type ShareType = 'slack' | 'gmail'

interface SavedMeeting {
  id: string
  title: string
  source?: 'live' | 'upload' | 'calendar' | 'drive' | string
  startedAt?: string | number | Date
  endedAt?: string | number | Date | null
  duration?: number | null
  summary?: string | null
  transcript?: string | null
  actionItemsJson?: unknown
  decisionsJson?: unknown
  sourceUri?: string | null
  processingStatus?: MeetingStatus | string | null
  processingMessage?: string | null
  processingProgress?: number | null
  lastError?: string | null
  createdAt?: string | number | Date
  updatedAt?: string | number | Date
}

interface ActivityEntry {
  id: string
  meetingId?: string | null
  type: string
  status: 'success' | 'error' | 'info'
  label: string
  detailJson?: unknown
  createdAt?: string | number | Date
}

interface SlackDestination {
  id: string
  name: string
  type: string
  isPrivate?: boolean
  isIm?: boolean
}

interface UploadFile {
  name: string
  path: string
  mimeType: string
  size: number
}

interface ShareDialogState {
  type: ShareType
  title: string
  meetingId?: string | null
  result: MeetingResult
}

interface AnalyzeTabProps {
  googleConnected: boolean
  onOpenChat: (message: string) => void
}

const ACCEPTED_TYPES = '.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg,.aiff,.vtt,.srt,.txt,.docx,.pdf'

function formatTimeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateValue(value: SavedMeeting['createdAt']): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTimeValue(value: ActivityEntry['createdAt']): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDurationSeconds(seconds?: number | null): string {
  if (!seconds) return ''
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

function parseArray<T>(input: unknown): T[] {
  if (Array.isArray(input)) return input as T[]
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return Array.isArray(parsed) ? parsed as T[] : []
    } catch {
      return []
    }
  }
  return []
}

function getMeetingStatus(meeting?: SavedMeeting | null): MeetingStatus {
  const raw = meeting?.processingStatus
  if (raw === 'queued' || raw === 'reading' || raw === 'transcribing' || raw === 'analyzing' || raw === 'error' || raw === 'interrupted') return raw
  return 'done'
}

function isWorkingStatus(status: MeetingStatus): boolean {
  return status === 'queued' || status === 'reading' || status === 'transcribing' || status === 'analyzing'
}

function statusLabel(meeting: SavedMeeting): string {
  const status = getMeetingStatus(meeting)
  if (status === 'done') return meeting.summary ? 'Summary ready' : meeting.transcript ? 'Transcript saved' : 'Saved'
  if (status === 'error') return 'Needs retry'
  if (status === 'interrupted') return 'Interrupted'
  if (status === 'queued') return 'Queued'
  if (status === 'reading') return 'Reading file'
  if (status === 'transcribing') return 'Transcribing locally'
  if (status === 'analyzing') return 'Analyzing'
  return 'Saved'
}

function statusColor(status: MeetingStatus): string {
  if (status === 'done') return 'var(--amber)'
  if (status === 'error' || status === 'interrupted') return 'var(--destructive)'
  return 'var(--muted-foreground)'
}

function resultFromMeeting(meeting?: SavedMeeting | null): MeetingResult | null {
  if (!meeting?.summary) return null
  return {
    summary: meeting.summary,
    actionItems: parseArray<{ owner?: string | null; task: string; dueDate?: string | null }>(meeting.actionItemsJson),
    decisions: parseArray<{ decision: string; context?: string | null }>(meeting.decisionsJson),
    openQuestions: [],
  }
}

function buildMarkdown(title: string, result: MeetingResult): string {
  const lines = [`# ${title || 'Meeting Notes'}`, '']
  if (result.summary) lines.push('## Summary', result.summary, '')
  if (result.actionItems.length) {
    lines.push('## Action Items')
    for (const item of result.actionItems) {
      lines.push(`- ${item.task}${item.owner ? ` (${item.owner})` : ''}${item.dueDate ? ` - due ${item.dueDate}` : ''}`)
    }
    lines.push('')
  }
  if (result.decisions.length) {
    lines.push('## Decisions')
    for (const item of result.decisions) {
      lines.push(`- ${item.decision}${item.context ? ` - ${item.context}` : ''}`)
    }
    lines.push('')
  }
  if (result.openQuestions.length) lines.push('## Open Questions', ...result.openQuestions.map(q => `- ${q}`), '')
  return lines.join('\n')
}

function buildChatDraft(title: string, result: MeetingResult): string {
  return `Here are the meeting notes for "${title}":\n\n${buildMarkdown(title, result)}\n\nPlease help me follow up on this meeting.`
}

function buildEmailDraft(title: string, result: MeetingResult): string {
  return `Hi,\n\nHere are the notes from ${title || 'the meeting'}.\n\n${buildMarkdown(title, result)}\n\nBest,\nWOS`
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function isTranscriptFile(file: UploadFile): boolean {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  return ['txt', 'vtt', 'srt', 'docx', 'pdf'].includes(ext)
}

function StatusPill({ meeting }: { meeting: SavedMeeting }) {
  const status = getMeetingStatus(meeting)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ background: 'var(--border)', color: statusColor(status) }}
    >
      {isWorkingStatus(status) && <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: statusColor(status) }} />}
      {statusLabel(meeting)}
    </span>
  )
}

type ResultTab = 'summary' | 'actions' | 'decisions'

function ResultPanel({
  result,
  title,
  disabled,
  onAskAi,
  onShare,
  onCopy,
  onExport,
}: {
  result: MeetingResult
  title: string
  disabled?: boolean
  onAskAi: () => void
  onShare: (type: ShareType) => void
  onCopy: () => void
  onExport: () => void
}) {
  const [activeTab, setActiveTab] = useState<ResultTab>('summary')

  const tabs: Array<{ id: ResultTab; label: string; count?: number }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'actions', label: 'Action Items', count: result.actionItems.length || undefined },
    { id: 'decisions', label: 'Decisions', count: result.decisions.length || undefined },
  ]

  return (
    <div className="space-y-3">
      {/* Actions bar */}
      <div className="rounded-xl p-3" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <ActionButton disabled={disabled} icon={<MessageSquare className="h-4 w-4" />} label="Ask AI" onClick={onAskAi} />
          <ActionButton disabled={disabled} icon={<Clipboard className="h-4 w-4" />} label="Copy" onClick={onCopy} />
          <ActionButton disabled={disabled} icon={<CloudDownload className="h-4 w-4" />} label="Export" onClick={onExport} />
          <ActionButton disabled={disabled} icon={<Mail className="h-4 w-4" />} label="Gmail" onClick={() => onShare('gmail')} />
          <ActionButton disabled={disabled} icon={<Hash className="h-4 w-4" />} label="Slack" onClick={() => onShare('slack')} />
        </div>
      </div>

      {/* Segmented result card */}
      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
        {/* Tab header */}
        <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors relative"
              style={{
                color: activeTab === tab.id ? 'var(--foreground)' : 'var(--muted-foreground)',
                borderBottom: activeTab === tab.id ? '2px solid var(--amber)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
                  style={{
                    background: activeTab === tab.id ? 'var(--amber-muted)' : 'var(--secondary)',
                    color: activeTab === tab.id ? 'var(--amber)' : 'var(--muted-foreground)',
                  }}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-4">
          {activeTab === 'summary' && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>
              {result.summary || 'No summary available.'}
            </p>
          )}

          {activeTab === 'actions' && (
            result.actionItems.length ? (
              <div className="space-y-3">
                {result.actionItems.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: 'var(--amber)' }} />
                    <div className="min-w-0">
                      <p>{item.task}</p>
                      {(item.owner || item.dueDate) && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                          {item.owner ?? 'Unassigned'}{item.dueDate ? ` · ${item.dueDate}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>No action items found in this meeting.</p>
            )
          )}

          {activeTab === 'decisions' && (
            result.decisions.length ? (
              <div className="space-y-3">
                {result.decisions.map((d, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Zap className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: 'var(--amber)' }} />
                    <div className="min-w-0">
                      <p className="font-medium">{d.decision}</p>
                      {d.context && <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{d.context}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>No key decisions found in this meeting.</p>
            )
          )}
        </div>
      </div>

      {/* Open Questions (stays separate) */}
      {result.openQuestions?.length > 0 && (
        <div className="rounded-xl p-4" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
          <div className="mb-3 flex items-center gap-2">
            <HelpCircle className="h-4 w-4" style={{ color: 'var(--muted-foreground)' }} />
            <span className="text-sm font-semibold">Open Questions</span>
          </div>
          <div className="space-y-1.5">
            {result.openQuestions.map((q, i) => (
              <p key={i} className="text-sm" style={{ color: 'var(--muted-foreground)' }}>? {q}</p>
            ))}
          </div>
        </div>
      )}

      <span className="sr-only">{title}</span>
    </div>
  )
}

function ActionButton({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
      style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
    >
      {icon} {label}
    </button>
  )
}

function SavedTranscriptSidebar({
  meetings,
  selectedId,
  query,
  onQueryChange,
  onSearch,
  onRefresh,
  onSelect,
  onDelete,
}: {
  meetings: SavedMeeting[]
  selectedId: string | null
  query: string
  onQueryChange: (v: string) => void
  onSearch: () => void
  onRefresh: () => void
  onSelect: (meeting: SavedMeeting) => void
  onDelete: (meeting: SavedMeeting) => void
}) {
  return (
    <aside className="rounded-2xl p-4 lg:sticky lg:top-4 lg:self-start" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>Previous transcripts</p>
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{meetings.length} saved</p>
        </div>
        <button onClick={onRefresh} className="rounded-lg p-1.5" title="Refresh" style={{ color: 'var(--muted-foreground)' }}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-lg px-2" style={{ border: '1px solid var(--border)', background: 'var(--input)' }}>
        <Search className="h-3.5 w-3.5" style={{ color: 'var(--muted-foreground)' }} />
        <input
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSearch() }}
          placeholder="Search transcripts..."
          className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none"
          style={{ color: 'var(--foreground)' }}
        />
      </div>

      <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: '430px' }}>
        {meetings.length === 0 ? (
          <div className="rounded-xl p-4 text-center" style={{ border: '1px dashed var(--border)' }}>
            <FileText className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--muted-foreground)' }} />
            <p className="text-xs font-medium">No transcripts yet</p>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>Upload a file to create the first row.</p>
          </div>
        ) : (
          meetings.map(meeting => (
            <button
              key={meeting.id}
              onClick={() => onSelect(meeting)}
              className="group w-full rounded-xl p-3 text-left transition-colors"
              style={{
                border: selectedId === meeting.id ? '1px solid var(--amber)' : '1px solid var(--border)',
                background: selectedId === meeting.id ? 'var(--surface-raised)' : 'var(--background)',
              }}
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium">{meeting.title}</p>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(meeting) }}
                  className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: 'var(--destructive)' }}
                  title="Delete transcript"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full px-2 py-0.5 text-[10px] capitalize" style={{ background: 'var(--border)', color: 'var(--muted-foreground)' }}>
                  {meeting.source ?? 'meeting'}
                </span>
                <StatusPill meeting={meeting} />
              </div>
              <p className="line-clamp-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                {meeting.processingMessage || meeting.summary || meeting.transcript || meeting.lastError || 'Waiting for transcript content.'}
              </p>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}

function UploadCard({
  dragActive,
  onDragActive,
  onDrop,
  onBrowse,
  fileInputRef,
  onNativeFile,
}: {
  dragActive: boolean
  onDragActive: (v: boolean) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onBrowse: () => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onNativeFile: (file: File) => void
}) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onDragActive(true) }}
      onDragLeave={() => onDragActive(false)}
      onDrop={onDrop}
      onClick={onBrowse}
      className="rounded-2xl p-8 text-center cursor-pointer transition-colors"
      style={{
        border: `2px dashed ${dragActive ? 'var(--amber)' : 'var(--border)'}`,
        background: dragActive ? 'var(--surface-subtle)' : 'var(--card)',
      }}
    >
      <Upload className="mx-auto mb-3 h-8 w-8" style={{ color: dragActive ? 'var(--amber)' : 'var(--muted-foreground)' }} />
      <p className="text-sm font-medium">{dragActive ? 'Drop to start background analysis' : 'Drop file or click to upload'}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>A transcript row is created immediately and processed in the background.</p>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>.mp4 .mov .webm .mp3 .wav .m4a .vtt .srt .txt .docx .pdf</p>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onNativeFile(file)
          e.currentTarget.value = ''
        }}
      />
    </div>
  )
}

function fileCategoryIcon(category: DriveFile['fileCategory']) {
  if (category === 'video') return <Video className="h-4 w-4 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
  if (category === 'audio') return <Mic className="h-4 w-4 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
  if (category === 'document') return <FileText className="h-4 w-4 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
  return <FileCode className="h-4 w-4 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
}

function DriveFolderPickerModal({
  onClose,
  onSelect,
}: {
  onClose: () => void
  onSelect: (folder: DriveFolder) => void
}) {
  const [folders, setFolders] = useState<DriveFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let mounted = true
    window.wos.meetings.listDriveFolders().then(res => {
      if (!mounted) return
      if (res.error) setError(res.error)
      else setFolders(res.folders as DriveFolder[])
      setLoading(false)
    })
    return () => { mounted = false }
  }, [])

  const filtered = folders.filter(f => f.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-3 p-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <h3 className="text-sm font-semibold">Choose a Google Drive folder</h3>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>WOS will list all supported files from this folder.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1" style={{ color: 'var(--muted-foreground)' }}><X className="h-4 w-4" /></button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 rounded-lg px-2" style={{ border: '1px solid var(--border)', background: 'var(--input)' }}>
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search folders..."
              className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none"
              style={{ color: 'var(--foreground)' }}
            />
          </div>

          <div className="overflow-y-auto space-y-1" style={{ maxHeight: '320px' }}>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <Loader2 className="h-4 w-4 animate-spin" /> Loading folders...
              </div>
            ) : error ? (
              <div className="flex items-start gap-2 rounded-xl p-3 text-xs" style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
                <AlertCircle className="h-4 w-4 shrink-0" /> {error}
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-xl p-5 text-center" style={{ border: '1px dashed var(--border)' }}>
                <FolderOpen className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--muted-foreground)' }} />
                <p className="text-xs">{query ? 'No folders match your search.' : 'No folders found in Google Drive.'}</p>
              </div>
            ) : (
              filtered.map(folder => (
                <button
                  key={folder.id}
                  onClick={() => onSelect(folder)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:opacity-80"
                  style={{ border: '1px solid var(--border)', background: 'var(--background)' }}
                >
                  <Folder className="h-4 w-4 shrink-0" style={{ color: 'var(--amber)' }} />
                  <span className="min-w-0 truncate font-medium">{folder.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex justify-end p-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ border: '1px solid var(--border)' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function DriveFilePickerModal({
  onClose,
  onAnalyze,
}: {
  onClose: () => void
  onAnalyze: (file: DriveFile) => void
}) {
  const [step, setStep] = useState<'folders' | 'files'>('folders')
  const [folders, setFolders] = useState<DriveFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [foldersError, setFoldersError] = useState<string | null>(null)
  const [folderQuery, setFolderQuery] = useState('')
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null)
  const [files, setFiles] = useState<DriveFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    window.wos.meetings.listDriveFolders().then(res => {
      if (!mounted) return
      if (res.error) setFoldersError(res.error)
      else setFolders(res.folders as DriveFolder[])
      setFoldersLoading(false)
    })
    return () => { mounted = false }
  }, [])

  const pickFolder = async (folder: DriveFolder) => {
    setSelectedFolder(folder)
    setStep('files')
    setFilesLoading(true)
    setFilesError(null)
    setFiles([])
    try {
      const { files: f, error } = await window.wos.meetings.listDriveFiles({ folderId: folder.id })
      if (error) throw new Error(error)
      setFiles(f as DriveFile[])
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : String(err))
    } finally {
      setFilesLoading(false)
    }
  }

  const filteredFolders = folders.filter(f => f.name.toLowerCase().includes(folderQuery.toLowerCase()))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 p-4" style={{ borderBottom: '1px solid var(--border)' }}>
          {step === 'files' && (
            <button onClick={() => setStep('folders')} className="rounded-lg p-1" style={{ color: 'var(--muted-foreground)' }}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold truncate">
              {step === 'folders' ? 'Browse Google Drive' : selectedFolder?.name}
            </h3>
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              {step === 'folders' ? 'Choose a folder to browse files' : 'Select a file to analyze'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 shrink-0" style={{ color: 'var(--muted-foreground)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4">
          {step === 'folders' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg px-2" style={{ border: '1px solid var(--border)', background: 'var(--input)' }}>
                <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
                <input
                  autoFocus
                  value={folderQuery}
                  onChange={e => setFolderQuery(e.target.value)}
                  placeholder="Search folders..."
                  className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none"
                  style={{ color: 'var(--foreground)' }}
                />
              </div>
              <div className="overflow-y-auto space-y-1" style={{ maxHeight: '300px' }}>
                {foldersLoading ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading folders...
                  </div>
                ) : foldersError ? (
                  <div className="flex items-start gap-2 p-3 text-xs" style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
                    <AlertCircle className="h-4 w-4 shrink-0" /> {foldersError}
                  </div>
                ) : filteredFolders.length === 0 ? (
                  <p className="py-6 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    {folderQuery ? 'No folders match your search.' : 'No folders found in Google Drive.'}
                  </p>
                ) : (
                  filteredFolders.map(folder => (
                    <button
                      key={folder.id}
                      onClick={() => void pickFolder(folder)}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:opacity-80"
                      style={{ border: '1px solid var(--border)', background: 'var(--background)' }}
                    >
                      <Folder className="h-4 w-4 shrink-0" style={{ color: 'var(--amber)' }} />
                      <span className="min-w-0 flex-1 truncate text-sm">{folder.name}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--muted-foreground)' }} />
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="overflow-y-auto space-y-2" style={{ maxHeight: '320px' }}>
              {filesLoading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  <Loader2 className="h-4 w-4 animate-spin" /> Scanning folder...
                </div>
              ) : filesError ? (
                <div className="flex items-start gap-2 p-3 text-xs" style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
                  <AlertCircle className="h-4 w-4 shrink-0" /> {filesError}
                </div>
              ) : files.length === 0 ? (
                <p className="py-8 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  No supported files (video, audio, transcript, PDF, DOCX) in this folder.
                </p>
              ) : (
                files.map(file => (
                  <div key={file.id} className="flex items-center gap-3 rounded-xl p-3" style={{ border: '1px solid var(--border)', background: 'var(--background)' }}>
                    {fileCategoryIcon(file.fileCategory)}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{file.displayName || file.name}</p>
                      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                        {formatDateValue(file.date)}{file.size ? ` · ${formatFileSize(file.size)}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => { onAnalyze(file); onClose() }}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium"
                      style={{ background: 'var(--amber)', color: '#000' }}
                    >
                      Analyze
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end p-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ border: '1px solid var(--border)' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function DriveImportCard({
  googleConnected,
  driveLoading,
  driveError,
  driveFiles,
  watchedFolderName,
  driveLastScanned,
  onRefresh,
  onAnalyze,
  onChooseFolder,
  onBrowseFile,
}: {
  googleConnected: boolean
  driveLoading: boolean
  driveError: string | null
  driveFiles: DriveFile[]
  watchedFolderName: string | null
  driveLastScanned: Date | null
  onRefresh: () => void
  onAnalyze: (file: DriveFile) => void
  onChooseFolder: () => void
  onBrowseFile: () => void
}) {
  return (
    <div className="rounded-2xl p-4" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>From Google Drive</p>
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {driveLastScanned ? `Scanned ${formatTimeAgo(driveLastScanned)} · auto-refreshes every 3h` : 'Select a folder to watch for saved meetings and files.'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onBrowseFile} disabled={!googleConnected} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs disabled:opacity-50" style={{ color: 'var(--muted-foreground)' }}>
            <Search className="h-3.5 w-3.5" /> Browse
          </button>
          <button onClick={onRefresh} disabled={driveLoading || !watchedFolderName} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs disabled:opacity-50" style={{ color: 'var(--muted-foreground)' }}>
            <RefreshCw className={cn('h-3.5 w-3.5', driveLoading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {/* Folder selector row */}
      <div className="mb-3 flex items-center gap-2 rounded-xl p-2.5" style={{ border: '1px solid var(--border)', background: 'var(--background)' }}>
        <Folder className="h-4 w-4 shrink-0" style={{ color: watchedFolderName ? 'var(--amber)' : 'var(--muted-foreground)' }} />
        <span className="min-w-0 flex-1 truncate text-sm" style={{ color: watchedFolderName ? 'var(--foreground)' : 'var(--muted-foreground)' }}>
          {watchedFolderName ?? 'No folder selected'}
        </span>
        <button
          onClick={onChooseFolder}
          disabled={!googleConnected}
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          {watchedFolderName ? 'Change' : 'Choose folder'}
        </button>
      </div>

      {!googleConnected ? (
        <p className="rounded-xl p-3 text-xs" style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>Connect Google Workspace in Settings to browse Drive.</p>
      ) : !watchedFolderName ? (
        <div className="rounded-xl p-5 text-center" style={{ border: '1px dashed var(--border)' }}>
          <FolderOpen className="mx-auto mb-2 h-6 w-6" style={{ color: 'var(--muted-foreground)' }} />
          <p className="text-xs font-medium">Choose a folder to get started</p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>WOS will list videos, audio, transcripts, and documents from that folder.</p>
        </div>
      ) : driveLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl p-5 text-xs" style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
          <Loader2 className="h-4 w-4 animate-spin" /> Scanning folder...
        </div>
      ) : driveError ? (
        <div className="flex items-start gap-2 rounded-xl p-3 text-xs" style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
          <AlertCircle className="h-4 w-4 shrink-0" /> {driveError}
        </div>
      ) : driveFiles.length === 0 ? (
        <div className="rounded-xl p-5 text-center" style={{ border: '1px dashed var(--border)' }}>
          <FolderOpen className="mx-auto mb-2 h-6 w-6" style={{ color: 'var(--muted-foreground)' }} />
          <p className="text-xs font-medium">No supported files found</p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>Add videos, audio, transcripts, PDFs, or DOCX files to this folder.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {driveFiles.map(file => (
            <div key={file.id} className="flex items-center gap-3 rounded-xl p-3" style={{ border: '1px solid var(--border)', background: 'var(--background)' }}>
              {fileCategoryIcon(file.fileCategory)}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.displayName || file.name}</p>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {formatDateValue(file.date)}
                  {file.size ? ` · ${formatFileSize(file.size)}` : ''}
                  {file.fileCategory === 'video' && file.hasTranscript ? ' · Transcript ✓' : ''}
                  {file.fileCategory === 'video' && !file.hasTranscript ? ' · Video only' : ''}
                  {file.fileCategory === 'audio' ? ' · Audio' : ''}
                  {file.fileCategory === 'document' ? ' · Document' : ''}
                  {file.fileCategory === 'transcript' ? ' · Transcript' : ''}
                </p>
              </div>
              <button onClick={() => onAnalyze(file)} className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: 'var(--amber)', color: '#000' }}>
                Analyze
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="rounded-2xl p-4" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4" style={{ color: 'var(--muted-foreground)' }} />
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>Activity</p>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>No actions yet.</p>
      ) : (
        <div className="space-y-2">
          {entries.slice(0, 5).map(entry => (
            <div key={entry.id} className="flex items-start justify-between gap-3 text-xs">
              <span style={{ color: entry.status === 'error' ? 'var(--destructive)' : 'var(--foreground)' }}>{entry.label}</span>
              <span className="shrink-0" style={{ color: 'var(--muted-foreground)' }}>{formatTimeValue(entry.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TranscriptDetail({
  meeting,
  activity,
  onBack,
  onShare,
  onCopy,
  onExport,
  onAskAi,
  onReanalyze,
  onRename,
  onDelete,
}: {
  meeting: SavedMeeting
  activity: ActivityEntry[]
  onBack: () => void
  onShare: (type: ShareType, result: MeetingResult) => void
  onCopy: (result: MeetingResult) => void
  onExport: (result: MeetingResult) => void
  onAskAi: (result: MeetingResult) => void
  onReanalyze: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const status = getMeetingStatus(meeting)
  const result = resultFromMeeting(meeting)
  const working = isWorkingStatus(status)
  const meta = [
    meeting.source,
    formatDateValue(meeting.startedAt ?? meeting.createdAt),
    formatDurationSeconds(meeting.duration),
  ].filter(Boolean).join(' - ')

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
        <button onClick={onBack} className="mb-3 flex items-center gap-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Analyze Home
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold">{meeting.title}</h3>
            <p className="mt-1 text-xs capitalize" style={{ color: 'var(--muted-foreground)' }}>{meta || 'Saved transcript'}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill meeting={meeting} />
            <button onClick={onRename} className="rounded-lg p-1.5" style={{ color: 'var(--muted-foreground)' }} title="Rename">
              <Edit3 className="h-4 w-4" />
            </button>
            <button onClick={onDelete} className="rounded-lg p-1.5" style={{ color: 'var(--destructive)' }} title="Delete">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {working && (
        <div className="rounded-2xl p-5" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
          <div className="mb-3 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--amber)' }} />
            <p className="text-sm font-medium">{meeting.processingMessage || statusLabel(meeting)}</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(5, Math.min(100, meeting.processingProgress ?? 20))}%`, background: 'var(--amber)' }} />
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>You can keep working. WOS will notify you when this analysis is ready.</p>
        </div>
      )}

      {(status === 'error' || status === 'interrupted') && (
        <div className="rounded-2xl p-4" style={{ border: '1px solid var(--destructive)', background: 'var(--card)' }}>
          <div className="mb-2 flex items-center gap-2" style={{ color: 'var(--destructive)' }}>
            <AlertCircle className="h-4 w-4" />
            <p className="text-sm font-medium">This transcript needs attention</p>
          </div>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{meeting.lastError || meeting.processingMessage || 'Processing stopped before completion.'}</p>
          <button onClick={onReanalyze} disabled={!meeting.transcript} className="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50" style={{ background: 'var(--amber)', color: '#000' }}>
            Retry analysis
          </button>
        </div>
      )}

      {result ? (
        <ResultPanel
          result={result}
          title={meeting.title}
          disabled={working}
          onAskAi={() => onAskAi(result)}
          onShare={(type) => onShare(type, result)}
          onCopy={() => onCopy(result)}
          onExport={() => onExport(result)}
        />
      ) : !working && status !== 'error' && (
        <div className="rounded-2xl p-5" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
          <p className="text-sm font-medium">Transcript saved without summary</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>Analyze this transcript to create a summary, action items, and shareable notes.</p>
          <button onClick={onReanalyze} disabled={!meeting.transcript} className="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50" style={{ background: 'var(--amber)', color: '#000' }}>
            Analyze this transcript
          </button>
        </div>
      )}

      {meeting.transcript && (
        <div className="rounded-2xl p-4" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>Transcript</p>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
            {meeting.transcript}
          </pre>
        </div>
      )}

      <ActivityLog entries={activity} />
    </div>
  )
}

function ShareDialog({
  state,
  onClose,
  onDone,
}: {
  state: ShareDialogState
  onClose: () => void
  onDone: () => void
}) {
  const markdown = useMemo(() => buildMarkdown(state.title, state.result), [state.title, state.result])
  const [draft, setDraft] = useState(state.type === 'gmail' ? buildEmailDraft(state.title, state.result) : markdown)
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(`Meeting notes: ${state.title}`)
  const [manualDestination, setManualDestination] = useState('')
  const [selectedDestination, setSelectedDestination] = useState('')
  const [destinations, setDestinations] = useState<SlackDestination[]>([])
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const [loadingDestinations, setLoadingDestinations] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (state.type !== 'slack') return
    let mounted = true
    setLoadingDestinations(true)
    window.wos.meetings.listSlackDestinations().then(res => {
      if (!mounted) return
      setDestinations(res.destinations as SlackDestination[])
      setDestinationError(res.error)
    }).finally(() => {
      if (mounted) setLoadingDestinations(false)
    })
    return () => { mounted = false }
  }, [state.type])

  const sendSlack = async () => {
    const channel = selectedDestination || manualDestination.trim()
    if (!channel) {
      toast.error('Choose a Slack destination or enter a channel/DM ID.')
      return
    }
    setSending(true)
    const res = await window.wos.meetings.postSlack({ channel, text: draft, meetingId: state.meetingId })
    setSending(false)
    if (res.ok) {
      toast.success('Sent to Slack')
      onDone()
      onClose()
    } else {
      toast.error(res.error ?? 'Failed to send to Slack')
      onDone()
    }
  }

  const sendGmail = async (asDraft: boolean) => {
    const recipients = to.split(',').map(v => v.trim()).filter(Boolean)
    if (recipients.length === 0 || recipients.some(v => !looksLikeEmail(v))) {
      toast.error('Enter a valid To email address.')
      return
    }
    if (!subject.trim()) {
      toast.error('Subject is required.')
      return
    }
    setSending(true)
    const res = asDraft
      ? await window.wos.meetings.createGmailDraft({ to, subject, body: draft, meetingId: state.meetingId })
      : await window.wos.meetings.emailNotes({ to, cc: cc || undefined, subject, body: draft, meetingId: state.meetingId })
    setSending(false)
    if (res.ok) {
      toast.success(asDraft ? 'Gmail draft saved' : 'Email sent')
      onDone()
      onClose()
    } else {
      toast.error(res.error ?? 'Gmail action failed')
      onDone()
    }
  }

  const title = state.type === 'slack' ? 'Review Slack message' : 'Compose Gmail draft'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-3 border-b p-4" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Review and edit before anything is sent.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1" style={{ color: 'var(--muted-foreground)' }}><X className="h-4 w-4" /></button>
        </div>

        <div className="max-h-[68vh] space-y-3 overflow-y-auto p-4">
          {state.type === 'slack' && (
            <div className="space-y-2">
              <label className="text-xs font-medium">Slack destination</label>
              {loadingDestinations ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading channels and DMs...</div>
              ) : destinations.length > 0 ? (
                <select value={selectedDestination} onChange={e => setSelectedDestination(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
                  <option value="">Choose destination...</option>
                  {destinations.map(dest => (
                    <option key={dest.id} value={dest.id}>{dest.type === 'dm' ? 'DM' : dest.type === 'group-dm' ? 'Group DM' : dest.isPrivate ? 'Private' : 'Channel'} - {dest.name} ({dest.id})</option>
                  ))}
                </select>
              ) : (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{destinationError || 'No Slack destinations available.'}</p>
              )}
              <input value={manualDestination} onChange={e => setManualDestination(e.target.value)} placeholder="Manual channel/DM ID fallback, e.g. C123 or D123" className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }} />
            </div>
          )}

          {state.type === 'gmail' && (
            <div className="space-y-2">
              <input value={to} onChange={e => setTo(e.target.value)} placeholder="To" className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }} />
              <input value={cc} onChange={e => setCc(e.target.value)} placeholder="Cc (optional)" className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }} />
              <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }} />
            </div>
          )}

          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="min-h-[280px] w-full resize-y rounded-xl p-3 text-sm leading-relaxed outline-none"
            style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          />
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t p-4" style={{ borderColor: 'var(--border)' }}>
          <button onClick={() => navigator.clipboard.writeText(draft).then(() => toast.success('Draft copied'))} className="rounded-lg px-3 py-1.5 text-sm" style={{ border: '1px solid var(--border)' }}>Copy draft</button>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ border: '1px solid var(--border)' }}>Cancel</button>
          {state.type === 'slack' && <button disabled={sending} onClick={sendSlack} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50" style={{ background: 'var(--amber)', color: '#000' }}><Send className="h-4 w-4" /> Send to Slack</button>}
          {state.type === 'gmail' && (
            <>
              <button disabled={sending} onClick={() => sendGmail(true)} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50" style={{ border: '1px solid var(--border)' }}><Edit3 className="h-4 w-4" /> Save Gmail draft</button>
              <button disabled={sending} onClick={() => sendGmail(false)} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50" style={{ background: 'var(--amber)', color: '#000' }}><Send className="h-4 w-4" /> Send email</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function AnalyzeTab({ googleConnected, onOpenChat }: AnalyzeTabProps) {
  const [meetings, setMeetings] = useState<SavedMeeting[]>([])
  const [meetingSearch, setMeetingSearch] = useState('')
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [analyzeMode, setAnalyzeMode] = useState<AnalyzeMode>('home')
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [watchedFolderId, setWatchedFolderId] = useState<string | null>(null)
  const [watchedFolderName, setWatchedFolderName] = useState<string | null>(null)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([])
  const [driveLoading, setDriveLoading] = useState(false)
  const [driveError, setDriveError] = useState<string | null>(null)
  const [driveLastScanned, setDriveLastScanned] = useState<Date | null>(null)
  const [showDriveFilePicker, setShowDriveFilePicker] = useState(false)
  const watchedFolderIdRef = useRef<string | null>(null)
  const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null)
  const [renameTarget, setRenameTarget] = useState<SavedMeeting | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedMeeting = useMemo(
    () => meetings.find(m => m.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  )

  const loadSavedMeetings = useCallback(async (query = meetingSearch) => {
    const { meetings: rows, error } = await window.wos.meetings.listSaved({ query })
    if (error) {
      toast.error(error)
      return
    }
    setMeetings(rows as SavedMeeting[])
  }, [meetingSearch])

  const loadActivity = useCallback(async (meetingId = selectedMeetingId) => {
    const { entries } = await window.wos.meetings.listActivity({ meetingId, limit: 20 })
    setActivity(entries as ActivityEntry[])
  }, [selectedMeetingId])

  const refreshAll = useCallback(async () => {
    await loadSavedMeetings()
    await loadActivity()
  }, [loadActivity, loadSavedMeetings])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    void loadActivity(selectedMeetingId)
  }, [loadActivity, selectedMeetingId])

  const loadDriveFiles = useCallback(async (folderId: string) => {
    setDriveLoading(true)
    setDriveError(null)
    try {
      const { files, error } = await window.wos.meetings.listDriveFiles({ folderId })
      if (error) throw new Error(error)
      setDriveFiles(files as DriveFile[])
      setDriveLastScanned(new Date())
    } catch (err) {
      setDriveError(err instanceof Error ? err.message : String(err))
    } finally {
      setDriveLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!googleConnected) return
    window.wos.meetings.getDriveConfig().then(({ folderId, folderName }) => {
      if (folderId) {
        setWatchedFolderId(folderId)
        setWatchedFolderName(folderName)
        watchedFolderIdRef.current = folderId
        void loadDriveFiles(folderId)
      }
    })
  }, [googleConnected, loadDriveFiles])

  // keep ref in sync so the interval callback always has the latest folderId
  useEffect(() => { watchedFolderIdRef.current = watchedFolderId }, [watchedFolderId])

  // 3-hour auto-refresh
  useEffect(() => {
    if (!watchedFolderId || !googleConnected) return
    const id = setInterval(() => {
      const fid = watchedFolderIdRef.current
      if (fid) void loadDriveFiles(fid)
    }, 3 * 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [watchedFolderId, googleConnected, loadDriveFiles])

  const handleSelectFolder = useCallback(async (folder: DriveFolder) => {
    setWatchedFolderId(folder.id)
    setWatchedFolderName(folder.name)
    setDriveFiles([])
    setDriveError(null)
    setDriveLastScanned(null)
    setShowFolderPicker(false)
    watchedFolderIdRef.current = folder.id
    await window.wos.meetings.setDriveConfig({ folderId: folder.id, folderName: folder.name })
    void loadDriveFiles(folder.id)
  }, [loadDriveFiles])

  const selectMeeting = useCallback((meeting: SavedMeeting) => {
    setSelectedMeetingId(meeting.id)
    setAnalyzeMode('detail')
  }, [])

  const addUiActivity = useCallback(async (label: string, type: string, status: 'success' | 'error' | 'info' = 'info', meetingId = selectedMeetingId) => {
    await window.wos.meetings.addActivity({ meetingId, type, status, label })
    await loadActivity(meetingId)
  }, [loadActivity, selectedMeetingId])

  const processTranscript = useCallback(async (id: string, title: string, transcript: string, source: 'upload' | 'drive', sourceUri?: string | null) => {
    const analyzed = await window.wos.meetings.analyze({ id, transcript, title, source, sourceUri })
    if (analyzed.error || !analyzed.result) throw new Error(analyzed.error ?? 'No analysis returned')
    await loadSavedMeetings()
    await loadActivity(id)
    setSelectedMeetingId(id)
    setAnalyzeMode('detail')
    toast.success(`Analysis ready: ${title}`)
  }, [loadActivity, loadSavedMeetings])

  const startFileJob = useCallback(async (file: UploadFile) => {
    const title = file.name.replace(/\.[^.]+$/, '')
    const pending = await window.wos.meetings.createPending({ title, source: 'upload', sourceUri: file.path })
    if (!pending.id) {
      toast.error(pending.error ?? 'Could not create transcript row')
      return
    }
    const id = pending.id
    setSelectedMeetingId(id)
    setAnalyzeMode('detail')
    await loadSavedMeetings()
    try {
      const transcriptFile = isTranscriptFile(file)
      await window.wos.meetings.updateStatus({ id, status: transcriptFile ? 'reading' : 'transcribing', message: transcriptFile ? 'Reading file' : 'Transcribing locally', progress: transcriptFile ? 25 : 35 })
      await loadSavedMeetings()
      const { transcript, error } = await window.wos.meetings.processFile({ filePath: file.path, fileName: file.name, mimeType: file.mimeType })
      if (error) throw new Error(error)
      if (!transcript) throw new Error('Could not extract text from file')
      await window.wos.meetings.updateStatus({ id, status: 'analyzing', message: 'Analyzing with Meeting Agent', progress: 80 })
      await loadSavedMeetings()
      await processTranscript(id, title, transcript, 'upload', file.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await window.wos.meetings.updateStatus({ id, status: 'error', message: 'Needs retry', progress: 100, lastError: message })
      await window.wos.meetings.addActivity({ meetingId: id, type: 'processing', status: 'error', label: `Processing failed: ${message}` })
      await loadSavedMeetings()
      await loadActivity(id)
      toast.error(`Analysis failed: ${title}`)
    }
  }, [loadActivity, loadSavedMeetings, processTranscript])

  const handleNativeFile = useCallback((file: File) => {
    const filePath = window.wos.meetings.getPathForFile(file)
    if (!filePath) {
      toast.error('Could not read the file path from Electron. Try Browse instead.')
      return
    }
    void startFileJob({ name: file.name, path: filePath, mimeType: file.type, size: file.size })
  }, [startFileJob])

  const handleBrowseFile = useCallback(async () => {
    const res = await window.wos.meetings.openFileDialog()
    if (res.error) {
      toast.error(res.error)
      return
    }
    if (res.file) void startFileJob(res.file)
  }, [startFileJob])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (file) handleNativeFile(file)
  }, [handleNativeFile])

  const handleAnalyzeDrive = useCallback(async (file: DriveFile) => {
    const title = file.displayName || file.name.replace(/\.[^.]+$/, '')
    const pending = await window.wos.meetings.createPending({ title, source: 'drive', sourceUri: file.webViewLink ?? file.id })
    if (!pending.id) {
      toast.error(pending.error ?? 'Could not create Drive transcript row')
      return
    }
    const id = pending.id
    setSelectedMeetingId(id)
    setAnalyzeMode('detail')
    await loadSavedMeetings()
    try {
      const useTranscript = file.hasTranscript && !!file.transcriptFileId && !!file.transcriptName
      const srcId = useTranscript ? file.transcriptFileId! : file.id
      const srcName = useTranscript ? file.transcriptName! : file.name
      const srcMime = useTranscript ? 'text/vtt' : file.mimeType

      const statusMsg =
        file.fileCategory === 'video' ? (useTranscript ? 'Reading transcript from Drive' : 'Transcribing Drive video') :
        file.fileCategory === 'audio' ? 'Transcribing Drive audio' :
        file.fileCategory === 'document' ? 'Reading Drive document' : 'Reading transcript'
      const statusKind = (file.fileCategory === 'transcript' || useTranscript) ? 'reading' : 'transcribing'

      await window.wos.meetings.updateStatus({ id, status: statusKind, message: statusMsg, progress: 35 })
      await loadSavedMeetings()

      const res = await window.wos.meetings.processDriveFile({ fileId: srcId, fileName: srcName, mimeType: srcMime })
      if (res.error) throw new Error(res.error)
      if (!res.transcript) throw new Error('No text detected in file')

      await window.wos.meetings.updateStatus({ id, status: 'analyzing', message: 'Analyzing with Meeting Agent', progress: 80 })
      await loadSavedMeetings()
      await processTranscript(id, title, res.transcript, 'drive', file.webViewLink ?? file.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await window.wos.meetings.updateStatus({ id, status: 'error', message: 'Needs retry', progress: 100, lastError: message })
      await window.wos.meetings.addActivity({ meetingId: id, type: 'processing', status: 'error', label: `Drive import failed: ${message}` })
      await loadSavedMeetings()
      await loadActivity(id)
      toast.error(`Drive analysis failed: ${title}`)
    }
  }, [loadActivity, loadSavedMeetings, processTranscript])

  const deleteMeeting = useCallback(async (meeting: SavedMeeting) => {
    if (!window.confirm(`Delete "${meeting.title}"? This removes the saved transcript.`)) return
    await window.wos.meetings.addActivity({ type: 'delete', status: 'info', label: `Deleted ${meeting.title}` })
    const res = await window.wos.meetings.deleteSaved({ ids: [meeting.id] })
    if (!res.ok) {
      toast.error(res.error ?? 'Delete failed')
      return
    }
    if (selectedMeetingId === meeting.id) {
      setSelectedMeetingId(null)
      setAnalyzeMode('home')
    }
    await refreshAll()
    toast.success('Transcript deleted')
  }, [refreshAll, selectedMeetingId])

  const openRenameDialog = useCallback((meeting: SavedMeeting) => {
    setRenameTarget(meeting)
    setRenameDraft(meeting.title)
  }, [])

  const confirmRename = useCallback(async () => {
    if (!renameTarget) return
    const title = renameDraft.trim()
    if (!title || title === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    const res = await window.wos.meetings.renameSaved({ id: renameTarget.id, title })
    if (!res.ok) {
      toast.error(res.error ?? 'Rename failed')
      return
    }
    await refreshAll()
    setRenameTarget(null)
    toast.success('Transcript renamed')
  }, [refreshAll, renameDraft, renameTarget])

  const copyResult = useCallback(async (meeting: SavedMeeting, result: MeetingResult) => {
    await window.wos.meetings.copyMarkdown({ title: meeting.title, result })
    await addUiActivity(`Copied notes for ${meeting.title}`, 'copy', 'success', meeting.id)
    toast.success('Meeting notes copied')
  }, [addUiActivity])

  const askAiAboutMeeting = useCallback(async (meeting: SavedMeeting, result: MeetingResult) => {
    onOpenChat(buildChatDraft(meeting.title, result))
    await addUiActivity(`Opened Ask AI draft for ${meeting.title}`, 'chat', 'success', meeting.id)
    toast.success('Ask AI draft opened')
  }, [addUiActivity, onOpenChat])

  const exportResult = useCallback(async (meeting: SavedMeeting, result: MeetingResult) => {
    const res = await window.wos.meetings.exportMarkdown({ title: meeting.title, result })
    if (res.ok) {
      await addUiActivity(`Exported notes for ${meeting.title}`, 'export', 'success', meeting.id)
      toast.success('Meeting notes exported')
    }
  }, [addUiActivity])

  const reanalyzeMeeting = useCallback(async (meeting: SavedMeeting) => {
    if (!meeting.transcript) {
      toast.error('This meeting has no transcript to analyze.')
      return
    }
    try {
      await window.wos.meetings.updateStatus({ id: meeting.id, status: 'analyzing', message: 'Re-analyzing with Meeting Agent', progress: 80, lastError: null })
      await loadSavedMeetings()
      await processTranscript(meeting.id, meeting.title, meeting.transcript, (meeting.source === 'drive' ? 'drive' : 'upload'), meeting.sourceUri)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [loadSavedMeetings, processTranscript])

  const homeActivity = selectedMeeting ? activity : activity

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <SavedTranscriptSidebar
          meetings={meetings}
          selectedId={selectedMeetingId}
          query={meetingSearch}
          onQueryChange={setMeetingSearch}
          onSearch={() => void loadSavedMeetings(meetingSearch)}
          onRefresh={() => void refreshAll()}
          onSelect={selectMeeting}
          onDelete={deleteMeeting}
        />

        <main className="min-w-0 space-y-4">
          {analyzeMode === 'detail' && selectedMeeting ? (
            <TranscriptDetail
              meeting={selectedMeeting}
              activity={activity}
              onBack={() => setAnalyzeMode('home')}
              onShare={(type, result) => setShareDialog({ type, title: selectedMeeting.title, meetingId: selectedMeeting.id, result })}
              onCopy={(result) => void copyResult(selectedMeeting, result)}
              onExport={(result) => void exportResult(selectedMeeting, result)}
              onAskAi={(result) => void askAiAboutMeeting(selectedMeeting, result)}
              onReanalyze={() => void reanalyzeMeeting(selectedMeeting)}
              onRename={() => openRenameDialog(selectedMeeting)}
              onDelete={() => void deleteMeeting(selectedMeeting)}
            />
          ) : (
            <>
              <div className="rounded-2xl p-4" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Analyze workspace</h3>
                    <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Upload a transcript, audio, or video file. WOS creates a row immediately and works in the background.</p>
                  </div>
                  <button onClick={() => { setSelectedMeetingId(null); setAnalyzeMode('home') }} className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: 'var(--amber)', color: '#000' }}>
                    New analysis
                  </button>
                </div>
              </div>

              <UploadCard
                dragActive={dragActive}
                onDragActive={setDragActive}
                onDrop={handleDrop}
                onBrowse={handleBrowseFile}
                fileInputRef={fileInputRef}
                onNativeFile={handleNativeFile}
              />

              <DriveImportCard
                googleConnected={googleConnected}
                driveLoading={driveLoading}
                driveError={driveError}
                driveFiles={driveFiles}
                watchedFolderName={watchedFolderName}
                driveLastScanned={driveLastScanned}
                onRefresh={() => {
                  const fid = watchedFolderIdRef.current
                  if (fid) { setDriveFiles([]); void loadDriveFiles(fid) }
                }}
                onAnalyze={(file) => void handleAnalyzeDrive(file)}
                onChooseFolder={() => setShowFolderPicker(true)}
                onBrowseFile={() => setShowDriveFilePicker(true)}
              />

              <ActivityLog entries={homeActivity} />
            </>
          )}
        </main>
      </div>

      {showFolderPicker && googleConnected && (
        <DriveFolderPickerModal
          onClose={() => setShowFolderPicker(false)}
          onSelect={(folder) => void handleSelectFolder(folder)}
        />
      )}

      {showDriveFilePicker && googleConnected && (
        <DriveFilePickerModal
          onClose={() => setShowDriveFilePicker(false)}
          onAnalyze={(file) => void handleAnalyzeDrive(file)}
        />
      )}

      {shareDialog && (
        <ShareDialog
          state={shareDialog}
          onClose={() => setShareDialog(null)}
          onDone={() => void refreshAll()}
        />
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
          <div className="w-full max-w-md rounded-2xl p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Rename transcript</h3>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Update the title shown in the transcript library.</p>
              </div>
              <button onClick={() => setRenameTarget(null)} className="rounded-lg p-1" style={{ color: 'var(--muted-foreground)' }}><X className="h-4 w-4" /></button>
            </div>
            <input
              autoFocus
              value={renameDraft}
              onChange={e => setRenameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void confirmRename() }}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setRenameTarget(null)} className="rounded-lg px-3 py-1.5 text-sm" style={{ border: '1px solid var(--border)' }}>Cancel</button>
              <button onClick={() => void confirmRename()} className="rounded-lg px-3 py-1.5 text-sm font-medium" style={{ background: 'var(--amber)', color: '#000' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AnalyzeTab
