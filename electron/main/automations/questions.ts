import type { AskUserExtras } from '../../../src/types'

interface PendingQuestion {
  questionId: string
  automationId: string
  runId: string
  question: string
  extras?: AskUserExtras
  resolve: (answer: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

const pending = new Map<string, PendingQuestion>()

export function registerQuestion(opts: Omit<PendingQuestion, 'timer'>): string {
  const timer = setTimeout(() => {
    const q = pending.get(opts.questionId)
    if (!q) return
    pending.delete(opts.questionId)
    q.reject(new Error(`Automation question timed out after 1 hour (automationId=${opts.automationId})`))
  }, TIMEOUT_MS)
  pending.set(opts.questionId, { ...opts, timer })
  return opts.questionId
}

export function answerQuestion(questionId: string, answer: string): boolean {
  const q = pending.get(questionId)
  if (!q) return false
  clearTimeout(q.timer)
  pending.delete(questionId)
  q.resolve(answer)
  return true
}

export function cancelQuestion(questionId: string, reason?: string): boolean {
  const q = pending.get(questionId)
  if (!q) return false
  clearTimeout(q.timer)
  pending.delete(questionId)
  q.reject(new Error(reason ?? 'Question cancelled'))
  return true
}

export function cancelQuestionsForRun(runId: string): void {
  for (const [id, q] of pending) {
    if (q.runId === runId) {
      clearTimeout(q.timer)
      pending.delete(id)
      q.reject(new Error('Automation run aborted'))
    }
  }
}

export function listPending(): Array<Omit<PendingQuestion, 'resolve' | 'reject' | 'timer'>> {
  return [...pending.values()].map(({ questionId, automationId, runId, question, extras }) => ({
    questionId, automationId, runId, question, extras,
  }))
}
