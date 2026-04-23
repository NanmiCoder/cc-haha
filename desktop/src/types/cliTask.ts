// Source: src/server/services/taskService.ts (CLI V2 Tasks)

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type CLITask = {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  taskListId: string
}

export type TaskListSummary = {
  id: string
  taskCount: number
  completedCount: number
  inProgressCount: number
  pendingCount: number
}
