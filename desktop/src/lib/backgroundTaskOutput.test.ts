import { describe, expect, it } from 'vitest'
import {
  isShellBackgroundTask,
  isSubagentBackgroundTask,
  normalizeBackgroundTaskOutputLines,
  resolveBackgroundTaskCommand,
  resolveBackgroundTaskTitle,
  tokenizeShellCommand,
} from './backgroundTaskOutput'
import type { UIMessage } from '../types/chat'

describe('backgroundTaskOutput', () => {
  it('strips ANSI escapes, normalizes CRLF, and resolves carriage-return overwrites', () => {
    const raw = [
      '\u001b[32mno runs found\u001b[0m\r\n',
      'Loading...\rRefreshing checks status every 20 seconds.\n',
      '\n',
      'Some checks are still pending\n',
    ].join('')

    expect(normalizeBackgroundTaskOutputLines(raw)).toEqual([
      'no runs found',
      'Refreshing checks status every 20 seconds.',
      '',
      'Some checks are still pending',
    ])
  })

  it('returns an empty array for empty output', () => {
    expect(normalizeBackgroundTaskOutputLines('')).toEqual([])
  })

  it('tokenizes shell commands into command words, args, and operators', () => {
    const segments = tokenizeShellCommand('gh run list --repo NanmiCoder/cc-haha && gh pr checks 2047 --watch')
    expect(segments.map((s) => `${s.tone}:${s.text}`).filter((s) => !s.startsWith('plain:'))).toEqual([
      'command:gh',
      'command:run',
      'command:list',
      'arg:--repo',
      'arg:NanmiCoder/cc-haha',
      'operator:&&',
      'command:gh',
      'command:pr',
      'command:checks',
      'arg:2047',
      'arg:--watch',
    ])
  })

  it('resolves exact shell command from matching Bash tool_use message', () => {
    const messages: UIMessage[] = [
      {
        id: 'm1',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        input: { command: 'gh pr checks 2047 --watch', run_in_background: true },
        timestamp: 1000,
      },
    ]

    expect(
      resolveBackgroundTaskCommand(messages, {
        toolUseId: 'tool-1',
        description: 'Watch GitHub CI checks',
      }),
    ).toBe('gh pr checks 2047 --watch')

    expect(
      resolveBackgroundTaskTitle(messages, {
        taskId: 't1',
        toolUseId: 'tool-1',
        description: 'Watch GitHub CI checks',
      }),
    ).toBe('Watch GitHub CI checks')

    expect(
      resolveBackgroundTaskTitle(messages, {
        taskId: 't1',
        toolUseId: 'tool-1',
      }),
    ).toBe('gh pr checks 2047 --watch')
  })

  it('classifies shell vs subagent background tasks accurately', () => {
    expect(isShellBackgroundTask({ taskType: 'local_bash' })).toBe(true)
    expect(isShellBackgroundTask({ taskType: 'local_agent' })).toBe(false)
    expect(isShellBackgroundTask({ taskType: 'local_workflow' })).toBe(false)
    expect(isShellBackgroundTask({ taskType: 'dream' })).toBe(false)
    expect(isSubagentBackgroundTask({ taskType: 'local_agent' })).toBe(true)
    expect(isSubagentBackgroundTask({ taskType: 'remote_agent' })).toBe(true)
    expect(isSubagentBackgroundTask({ taskType: 'local_bash' })).toBe(false)
  })
})
