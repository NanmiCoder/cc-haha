/** v0 tasks keep their independent process and host-local cron semantics. */
export function migrateScheduledTasks(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scheduled task storage')
  const document = value as Record<string, unknown>
  if (typeof document.schemaVersion === 'number' && document.schemaVersion > 1) throw new Error('Unsupported scheduled task storage version')
  if (!Array.isArray(document.tasks)) throw new Error('Invalid scheduled task list')
  return {
    ...document,
    schemaVersion: 1,
    tasks: document.tasks.map(task => {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('Invalid scheduled task record')
      return { ...task, revision: task.revision ?? 1 }
    }),
  }
}
