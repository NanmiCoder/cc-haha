// Source: src/server/services/cronService.ts

export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop' | 'telegram' | 'feishu')[]
}

export type CronTask = {
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

export type CreateTaskInput = {
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
  exitCode?: number
  durationMs?: number
  sessionId?: string
}
