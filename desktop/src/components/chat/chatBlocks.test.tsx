import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { PermissionDialog } from './PermissionDialog'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'

describe('chat blocks', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ activeTabId: 'active-tab', tabs: [{ sessionId: 'active-tab', title: 'Test', type: 'session' as const, status: 'idle' }] })
    useChatStore.setState({ sessions: {} })
  })

  it('shows thinking expanded by default', () => {
    const { container } = render(<ThinkingBlock content="this is a long internal reasoning trace" isActive />)

    expect(screen.getByText(/Thinking/)).toBeTruthy()
    expect(container.textContent).toContain('this is a long internal reasoning trace')
    expect(container.querySelector('.thinking-cursor')).not.toBeNull()
  })

  it('does not animate inactive historical thinking blocks', () => {
    const { container } = render(<ThinkingBlock content="old reasoning" isActive={false} />)

    // Auto-collapsed by default; click to expand
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))

    expect(container.textContent).toContain('old reasoning')
    expect(container.querySelector('.thinking-cursor')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))

    expect(container.textContent).not.toContain('old reasoning')
    expect(container.querySelector('.thinking-cursor')).toBeNull()
  })

  it('renders thinking content as markdown after expanding and hides it after collapsing', () => {
    const { container } = render(<ThinkingBlock content={'**important**\n\n- item one'} />)

    // Auto-collapsed by default; click to expand
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))

    expect(container.querySelector('strong')?.textContent).toBe('important')
    expect(container.querySelector('li')?.textContent).toBe('item one')

    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))

    expect(container.textContent).not.toContain('important')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('li')).toBeNull()
  })

  it('shows full thinking content after expanding and hides it after collapsing', () => {
    const content = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n')
    const { container } = render(<ThinkingBlock content={content} />)

    // Auto-collapsed by default; click to expand
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))

    expect(container.textContent).toContain('line-1')
    expect(container.textContent).toContain('line-11')
    expect(container.textContent).toContain('line-12')

    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))

    expect(container.textContent).not.toContain('line-1')
    expect(container.textContent).not.toContain('line-11')
  })

  it('shows tool previews only after expanding the tool block', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Read"
        input={{ file_path: '/tmp/example.ts', limit: 20 }}
        result={{ content: 'const answer = 42\nconsole.log(answer)', isError: false }}
      />,
    )

    expect(container.textContent).toContain('Read')
    expect(container.textContent).not.toContain('const answer = 42')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Tool Input')
    expect(container.textContent).not.toContain('const answer = 42')
  })

  it('does not surface bash stdout in the transcript preview', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'ls -la', description: 'List files' }}
        result={{ content: 'file-a\nfile-b\nfile-c', isError: false }}
      />,
    )

    expect(container.textContent).toContain('Bash')
    expect(container.textContent).not.toContain('file-a')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('ls -la')
    expect(container.textContent).not.toContain('file-a')
  })

  it('shows pending Write tool calls while input is still streaming', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Write"
        input={{ file_path: '/private/tmp/ai-code-novel.md' }}
        isPending
        partialInput={'{"file_path":"/private/tmp/ai-code-novel.md","content":"第一章'}
      />,
    )

    expect(container.textContent).toContain('Write')
    expect(container.textContent).toContain('ai-code-novel.md')
    expect(container.textContent).toContain('Generating content')
  })

  it('expands pending Write tool calls into a live writer preview instead of raw JSON', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Write"
        input={{ file_path: '/private/tmp/ai-code-novel.md' }}
        isPending
        partialInput={'{"file_path":"/private/tmp/ai-code-novel.md","content":"# 第一章\\n\\n正文正在生成'}
      />,
    )

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Writer')
    expect(container.textContent).toContain('# 第一章')
    expect(container.textContent).toContain('正文正在生成')
    expect(container.textContent).not.toContain('"content"')
  })

  it('windows long pending Write previews to the latest content', () => {
    const lines = Array.from({ length: 180 }, (_, index) => `line-${index + 1}`)
    const escapedContent = lines.join('\\n')
    const { container } = render(
      <ToolCallBlock
        toolName="Write"
        input={{ file_path: '/private/tmp/generated.ts' }}
        isPending
        partialInput={`{"file_path":"/private/tmp/generated.ts","content":"${escapedContent}`}
      />,
    )

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('latest')
    expect(container.textContent).toContain('line-180')
    expect(container.textContent).not.toContain('line-30')
  })

  it('shows a collapsed error summary for failed bash commands', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'git show 5016bc0 --no-stat', description: 'Show full diff of latest commit' }}
        result={{ content: 'fatal: unrecognized argument: --no-stat\nExit code 128', isError: true }}
      />,
    )

    expect(container.textContent).toContain('Bash')
    expect(container.textContent).toContain('fatal: unrecognized argument: --no-stat')
  })

  it('shows full bash error output when the tool block is expanded', () => {
    const lines = Array.from({ length: 8 }, (_, index) => `detail line ${index + 1}`)
    const fullError = [
      '<tool_use_error>InputValidationError: Bash failed due to the following issues: The required parameter `description` is missing.',
      ...lines,
      'final remediation hint: provide a concise command description.',
    ].join('\n')
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'bun run check:server' }}
        result={{ content: fullError, isError: true }}
      />,
    )

    expect(container.textContent).toContain('InputValidationError')
    expect(container.textContent).not.toContain('final remediation hint')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Error Output')
    expect(container.textContent).toContain('detail line 8')
    expect(container.textContent).toContain('final remediation hint')
  })

  it('shows read tool validation errors when the tool block is expanded', () => {
    const fullError = [
      '<tool_use_error>InputValidationError: Read failed due to the following issues:',
      'The required parameter `file_path` is missing.',
      'The provided limit must be greater than 0.',
    ].join('\n')
    const { container } = render(
      <ToolCallBlock
        toolName="Read"
        input={{}}
        result={{ content: fullError, isError: true }}
      />,
    )

    expect(container.textContent).toContain('Read')
    expect(container.textContent).not.toContain('file_path')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Error Output')
    expect(container.textContent).toContain('file_path')
    expect(container.textContent).toContain('limit must be greater than 0')
  })

  it('keeps edit previews while showing edit tool error output when expanded', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Edit"
        input={{
          file_path: '/tmp/example.ts',
          old_string: 'const enabled = false',
          new_string: 'const enabled = true',
        }}
        result={{
          content: [
            'InputValidationError: Edit failed due to the following issues:',
            'The provided old_string was not found in the file.',
          ].join('\n'),
          isError: true,
        }}
      />,
    )

    expect(container.textContent).toContain('Edit')
    expect(container.textContent).not.toContain('old_string was not found')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('example.ts')
    expect(container.textContent).toContain('Error Output')
    expect(container.textContent).toContain('old_string was not found')
  })

  it('expands tool errors so full Computer Use gate messages are readable', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="mcp__computer-use__left_click"
        input={{ coordinate: [120, 220] }}
        result={{
          content: '"Claude Code Haha" is not in the allowed applications and is currently in front. Take a new screenshot — it may have appeared since your last one.',
          isError: true,
        }}
      />,
    )

    expect(container.textContent).toContain('mcp__computer-use__left_click')
    expect(container.textContent).not.toContain('Take a new screenshot')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Take a new screenshot')
    expect(container.textContent).toContain('allowed applications')
  })

  it('shows a diff preview for edit permission requests', async () => {
    useChatStore.setState({
      sessions: {
        'active-tab': {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: {
            requestId: 'perm-1',
            toolName: 'Edit',
            input: {
              file_path: '/tmp/example.ts',
              old_string: 'const count = 1',
              new_string: 'const count = 2',
            },
          },
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    let container!: HTMLElement
    await act(async () => {
      container = render(
        <PermissionDialog
          requestId="perm-1"
          toolName="Edit"
          input={{
            file_path: '/tmp/example.ts',
            old_string: 'const count = 1',
            new_string: 'const count = 2',
          }}
        />,
      ).container
      await Promise.resolve()
    })

    expect(container.textContent).toContain('/tmp/example.ts')
    expect(container.textContent).toContain('Allow')
    // react-diff-viewer-continued uses styled-components tables that don't
    // fully render in jsdom, so we verify the DiffViewer wrapper is mounted
    expect(container.querySelector('[class*="rounded-[var(--radius-lg)]"]')).toBeTruthy()
  })
})
