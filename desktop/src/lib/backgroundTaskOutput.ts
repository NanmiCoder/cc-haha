import type { BackgroundAgentTask, UIMessage } from '../types/chat'

// Matches ANSI CSI sequences (colors, cursor movement, line clearing), OSC sequences
// (window titles, hyperlinks), and 2-byte ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g

/**
 * Strip ANSI control sequences and resolve terminal carriage-return overwrites
 * so live CLI output (like spinners or progress refreshes) reads cleanly line by line.
 */
export function normalizeBackgroundTaskOutputLines(raw: string): string[] {
  if (!raw) return []
  const cleaned = raw.replace(ANSI_ESCAPE_PATTERN, '').replace(/\r\n/g, '\n')
  const rawLines = cleaned.split('\n')
  // Drop a single trailing empty entry created by a terminal trailing newline
  // so the last line number matches actual lines written.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop()
  }
  return rawLines.map((line) => {
    if (!line.includes('\r')) return line
    const segments = line.split('\r')
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i]!.length > 0) return segments[i]!
    }
    return ''
  })
}

export type ShellCommandSegment = {
  text: string
  tone: 'command' | 'arg' | 'operator' | 'plain'
}

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '2>&1', '&'])

/**
 * Lightweight tokenizer for the command banner above background task output:
 * highlights the leading executable/subcommand in primary ink and flags/args in
 * warm property ink, matching the calm contrast of the reference output viewer.
 */
export function tokenizeShellCommand(command: string): ShellCommandSegment[] {
  if (!command) return []
  const parts = command.match(/\s+|"[^"]*"|'[^']*'|&&|\|\||>>|2>&1|[|;&>]|[^\s|;&>]+/g)
  if (!parts) return [{ text: command, tone: 'plain' }]

  const segments: ShellCommandSegment[] = []
  let expectCommand = true
  let commandWordCount = 0

  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      segments.push({ text: part, tone: 'plain' })
      continue
    }
    if (SHELL_OPERATORS.has(part)) {
      segments.push({ text: part, tone: 'operator' })
      expectCommand = true
      commandWordCount = 0
      continue
    }
    if (part.startsWith('-')) {
      expectCommand = false
      segments.push({ text: part, tone: 'arg' })
      continue
    }
    if (expectCommand) {
      // Allow up to two leading command words (e.g. `gh run`, `git status`, `bun run`)
      // before switching arguments to the softer accent tone.
      segments.push({ text: part, tone: 'command' })
      commandWordCount += 1
      if (commandWordCount >= 3) expectCommand = false
      continue
    }
    segments.push({ text: part, tone: 'arg' })
  }

  return segments
}

export function isShellBackgroundTask(
  task: Pick<BackgroundAgentTask, 'taskType' | 'outputFile'>,
): boolean {
  if (task.taskType === 'local_bash') return true
  if (task.taskType === 'local_agent' || task.taskType === 'remote_agent') return false
  if (task.taskType === 'local_workflow' || task.taskType === 'dream' || task.taskType === 'in_process_teammate') {
    return false
  }
  return Boolean(task.outputFile || !task.taskType)
}

export function isSubagentBackgroundTask(
  task: Pick<BackgroundAgentTask, 'taskType'>,
): boolean {
  return Boolean(task.taskType?.includes('agent'))
}

export function resolveBackgroundTaskCommand(
  messages: readonly UIMessage[],
  task: Pick<BackgroundAgentTask, 'toolUseId' | 'description' | 'prompt'> | undefined,
): string | null {
  const toolUseId = task?.toolUseId
  if (toolUseId) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (!msg || msg.type !== 'tool_use' || msg.toolUseId !== toolUseId) continue
      if (msg.toolName !== 'Bash' && msg.toolName !== 'PowerShell') continue
      if (msg.input && typeof msg.input === 'object') {
        const command = (msg.input as Record<string, unknown>).command
        if (typeof command === 'string' && command.trim()) return command.trim()
      }
    }
  }
  if (task?.prompt?.trim()) return task.prompt.trim()
  if (task?.description?.trim()) return task.description.trim()
  return null
}

export function resolveBackgroundTaskTitle(
  messages: readonly UIMessage[],
  task: Pick<BackgroundAgentTask, 'taskId' | 'toolUseId' | 'description' | 'workflowName' | 'prompt'>,
): string {
  if (task.description?.trim()) return task.description.trim()
  if (task.workflowName?.trim()) return task.workflowName.trim()
  const command = resolveBackgroundTaskCommand(messages, task)
  if (command) return command
  return task.taskId
}
