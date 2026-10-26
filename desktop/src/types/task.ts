// Source: src/server/services/cronService.ts

export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop' | 'telegram' | 'feishu')[]
}

export type TaskSchedule =
  | { kind: 'once'; runAt: string; timeZone: string }
  | { kind: 'cron'; expression: string; timeZone: string }

export type TaskExecution = { kind: 'session'; targetSessionId: string } | { kind: 'new-session' }
export type TaskNotificationPolicy = 'important' | 'all' | 'failed' | 'none'
export type ScheduledTaskTrigger = { taskId: string; runId: string; scheduledFor: string; taskName: string }

type TaskOptions = {
  schedule?: TaskSchedule
  execution?: TaskExecution
  sourceSessionId?: string
  revision?: number
  notificationPolicy?: TaskNotificationPolicy
  scheduleState?: 'active' | 'paused' | 'completed'
}

export type CronTask = TaskOptions & {
  id: string
  name: string
  description?: string
  cron: string
  prompt: string
  enabled: boolean
  recurring?: boolean
  permanent?: boolean
  createdAt: number
  lastRunAt?: number
  lastFiredAt?: string
  nextRunAt?: number
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
}

export type CreateTaskInput = TaskOptions & {
  name: string
  description?: string
  cron: string
  prompt: string
  enabled?: boolean
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
}

export type TaskRun = {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  prompt: string
  output?: string
  error?: string
  outputPreview?: string
  errorPreview?: string
  hasOutput?: boolean
  hasError?: boolean
  exitCode?: number
  durationMs?: number
  sessionId?: string
  notificationDecision?: 'notify' | 'silent'
}
