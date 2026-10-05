import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ToolCallBlock } from './ToolCallBlock'
import { useSettingsStore } from '../../stores/settingsStore'
import { translate } from '../../i18n'

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params)

function openRow(container: HTMLElement) {
  fireEvent.click(container.querySelector('[data-chat-disclosure="true"]')!)
}

describe('ToolCallBlock · timeline row', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('shows an edit as +N −N on the row and the same counts on its diff block', () => {
    const { container } = render(
      <ToolCallBlock
        chrome="row"
        toolName="Edit"
        input={{ file_path: '/repo/src/validators.ts', old_string: 'a\nb', new_string: 'a\nB\nc' }}
        result={{ content: 'The file has been updated.', isError: false }}
      />,
    )

    const head = container.querySelector<HTMLElement>('[data-chat-disclosure="true"]')!
    expect(head.textContent).toContain(t('toolVerb.edit'))
    expect(head.textContent).toContain('validators.ts')
    expect(head.textContent).toContain('+2')
    expect(head.textContent).toContain('−1')
    expect(head.getAttribute('title')).toBe('Edit · /repo/src/validators.ts')

    openRow(container)
    const diff = within(container.querySelector<HTMLElement>('[data-diff-block]')!)
    expect(diff.getByText('+2')).toBeTruthy()
    expect(diff.getByText('−1')).toBeTruthy()
    // The directory gives way first; the file name always stays readable.
    expect(diff.getByText('validators.ts').className).toContain('shrink-0')
    expect(diff.getByTitle('/repo/src/validators.ts')).toBeTruthy()
  })

  it('draws a TodoWrite call as its checklist rather than its JSON', () => {
    const { container } = render(
      <ToolCallBlock
        chrome="row"
        toolName="TodoWrite"
        input={{
          todos: [
            { content: 'Read the form', status: 'completed', activeForm: 'Reading' },
            { content: 'Extract validators', status: 'in_progress', activeForm: 'Extracting' },
            { content: 'Add tests', status: 'pending', activeForm: 'Adding' },
          ],
        }}
        result={{ content: 'Todos have been modified successfully.', isError: false }}
      />,
    )

    const head = container.querySelector<HTMLElement>('[data-chat-disclosure="true"]')!
    expect(head.textContent).toContain(t('toolVerb.updateTodos'))
    expect(head.textContent).not.toContain('TodoWrite')
    expect(head.textContent).toContain(t('tool.itemCountPlural', { count: 3 }))

    openRow(container)
    const items = [...container.querySelectorAll('[data-todo-list] li')]
    expect(items.map((item) => item.getAttribute('data-todo-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(items[0]?.querySelector('span')?.className).toContain('line-through')
    expect(container.textContent).not.toContain('activeForm')
    expect(container.textContent).not.toContain('Todos have been modified')
  })

  it('lays grep hits out as file:line plus code, with the match marked', () => {
    const { container } = render(
      <ToolCallBlock
        chrome="row"
        toolName="Grep"
        input={{ pattern: 'EMAIL_RE', output_mode: 'content', '-n': true }}
        result={{ content: 'src/a.ts:3:const EMAIL_RE = /x/\nsrc/b.ts:9:EMAIL_RE.test(v)', isError: false }}
      />,
    )

    const head = container.querySelector<HTMLElement>('[data-chat-disclosure="true"]')!
    expect(head.textContent).toContain(t('toolVerb.search'))
    expect(head.textContent).toContain('EMAIL_RE')
    expect(head.textContent).toContain(`${t('tool.fileCountPlural', { count: 2 })} · ${t('tool.matchCountPlural', { count: 2 })}`)

    openRow(container)
    const hits = container.querySelector<HTMLElement>('[data-search-result]')!
    expect(hits.textContent).toContain('src/a.ts:3')
    expect([...hits.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['EMAIL_RE', 'EMAIL_RE'])
  })

  it('heads a shell call with its exit code, not window decoration', () => {
    const { container } = render(
      <ToolCallBlock
        chrome="row"
        toolName="Bash"
        input={{ command: 'git show HEAD --no-stat', description: 'Show the commit' }}
        result={{ content: 'fatal: unrecognized argument: --no-stat\nExit code 128', isError: true }}
        durationMs={420}
      />,
    )

    openRow(container)
    const terminal = container.querySelector<HTMLElement>('[data-terminal-chrome]')!
    expect(within(terminal).getByText(t('tool.exitCode', { code: 128 }))).toBeTruthy()
    expect(terminal.querySelector('[data-shell-exit]')?.className).toContain('--color-error-container')
    expect(terminal.textContent).toContain('420ms')
    expect(terminal.textContent).toContain('git show HEAD --no-stat')
    // A light theme gets a sunken code ground, never the old black slab.
    expect(terminal.className).toContain('bg-[var(--color-code-bg)]')
    expect(terminal.className).not.toContain('terminal-bg')
  })

  it('reports a successful command as exit 0', () => {
    const { container } = render(
      <ToolCallBlock
        chrome="row"
        toolName="Bash"
        input={{ command: 'ls' }}
        result={{ content: 'a.txt', isError: false }}
      />,
    )
    openRow(container)
    expect(screen.getByText(t('tool.exitCode', { code: 0 })).className).toContain('--color-success-container')
  })

  it('colours the node by state: running blue, waiting amber, failed red', () => {
    const { container, rerender } = render(
      <ToolCallBlock chrome="row" toolName="Bash" input={{ command: 'sleep 1' }} running />,
    )
    const node = () => container.querySelector<HTMLElement>('[data-tool-node]')!
    expect(node().getAttribute('data-tool-node')).toBe('running')
    expect(node().className).toContain('--color-info')

    rerender(<ToolCallBlock chrome="row" toolName="Bash" input={{ command: 'sleep 1' }} awaitingApproval />)
    expect(node().getAttribute('data-tool-node')).toBe('waiting')
    expect(node().className).toContain('--color-warning')
    expect(container.textContent).toContain(t('permission.awaitingApproval'))

    rerender(<ToolCallBlock chrome="row" toolName="Bash" input={{ command: 'sleep 1' }} result={{ content: 'boom', isError: true }} />)
    expect(node().getAttribute('data-tool-node')).toBe('error')
    expect(node().className).toContain('--color-error-container')
  })
})
