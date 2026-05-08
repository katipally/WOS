/**
 * Meetings manager: single import surface for the meetings domain.
 *
 * Re-exports the existing storage and analysis helpers so callers can
 * `import { ... } from '../meetings/manager'` and find everything in one
 * place, mirroring the role of `projects/manager.ts`. Lifecycle orchestration
 * (record → transcribe → analyze) is driven by `ipc/meetings.ts`; this module
 * is the thin domain façade those handlers compose against.
 *
 * Persona, skills, and hooks for the meetings agent live under
 * `electron/main/agents/meeting/` (see `AGENTS.md`).
 */

export {
  saveMeeting,
  listMeetings,
  searchMeetings,
  deleteMeetings,
  getMeeting,
  updateMeetingStatus,
  renameMeeting,
  createPendingMeeting,
  addMeetingActivity,
  listMeetingActivity,
  type MeetingAnalysis,
  type MeetingProcessingStatus,
  type SaveMeetingInput,
} from './store'

export {
  analyzeTranscript,
  clampTranscript,
  asResult,
  type MeetingAnalysisResult,
} from './analyze'
