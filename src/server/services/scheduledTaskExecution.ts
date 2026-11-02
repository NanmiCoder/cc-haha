import type { CronTask } from './cronService.js'

export type ScheduledSessionTaskInput = {
  task: CronTask
  runId: string
  occurrenceId: string
  scheduledFor: string
  signal: AbortSignal
  canSend(): Promise<boolean>
  onSessionResolved?(sessionId: string): Promise<void>
}
export type ScheduledSessionTaskResult = {
  status: 'completed' | 'failed' | 'timeout'
  sessionId?: string
  output?: string
  error?: string
  notificationDecision?: 'notify' | 'silent'
}
export type ScheduledSessionTaskExecutor = {
  canStart(task: CronTask): Promise<boolean>
  execute(input: ScheduledSessionTaskInput): Promise<ScheduledSessionTaskResult>
}
let executor: ScheduledSessionTaskExecutor | undefined
export function setScheduledSessionTaskExecutor(value: ScheduledSessionTaskExecutor): () => void {
  executor = value
  return () => { if (executor === value) executor = undefined }
}
export function getScheduledSessionTaskExecutor(): ScheduledSessionTaskExecutor | undefined { return executor }
