export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool only when the user explicitly asks to cancel/stop a task, or when
  the task is clearly runaway, harmful, duplicative, or no longer useful.
- Do not stop a background agent merely because you have already read enough of
  its output. Prefer waiting for the automatic completion notification or
  leaving it running while you summarize available progress.
`
