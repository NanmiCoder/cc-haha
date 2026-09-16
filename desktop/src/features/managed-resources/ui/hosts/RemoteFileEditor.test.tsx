import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import '@testing-library/jest-dom'
import { useSettingsStore } from '@/stores/settingsStore'
import { t } from '@/i18n'
import { RemoteFileEditor, remoteFileLanguage } from './RemoteFileEditor'

const label = () => t('managedResources.files.editorLabel')
const seen = vi.fn()
function Controlled({ path = '/docs/readme.md', initial = '', disabled = false }: { path?: string; initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return <RemoteFileEditor absolutePath={path} value={value} onChange={next => { seen(next); setValue(next) }} disabled={disabled} />
}
function paste(editor: HTMLElement, value: string) {
  fireEvent.paste(editor, { clipboardData: { getData: (format: string) => format === 'text/plain' ? value : '<script>bad()</script>', files: [] } })
}
function selectAll(editor: HTMLElement) {
  act(() => editor.focus())
  fireEvent.keyDown(editor, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true })
}
const rect = () => ({ left: 0, top: 0, right: 1, bottom: 20, width: 1, height: 20, x: 0, y: 0, toJSON() { return {} } })
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  seen.mockClear()
  // jsdom has no layout. Only geometry is substituted; editor/model/transactions are real.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: rect })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect()] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('remote file user editing', () => {
  it.each(['.bashrc', '.barshrc', '.bash_profile', '.profile', 'profile', 'script.sh'])('selects Bash editing for %s without changing its contents', name => {
    const initial = 'export LANG=C.UTF-8\n'
    render(<Controlled path={'/home/fixture/' + name} initial={initial} />)
    expect(screen.getByTestId('remote-file-edit-surface')).toHaveAttribute('data-editor-language', 'bash')
    const editor = screen.getByRole('textbox', { name: label() })
    expect(editor).toHaveValue(initial)
    expect(editor).toHaveAttribute('spellcheck', 'false')
    fireEvent.change(editor, { target: { value: initial + '# 中文\n' } })
    expect(seen).toHaveBeenLastCalledWith(initial + '# 中文\n')
  })

  it('uses the real Bash highlighter and retains native textarea input', async () => {
    const view = render(<Controlled path="/etc/profile" initial={'# Comment\nexport PATH="$HOME/bin:$PATH"\n'} />)
    await waitFor(() => expect(view.container.querySelector('[data-highlight-engine=shiki]')).toBeInTheDocument(), { timeout: 10000 })
    expect(view.container.querySelectorAll('[data-remote-code-token]').length).toBeGreaterThan(3)
    const editor = screen.getByRole('textbox', { name: label() })
    fireEvent.change(editor, { target: { value: 'echo "中文"\n' } })
    expect(editor).toHaveValue('echo "中文"\n')
    expect(seen).toHaveBeenLastCalledWith('echo "中文"\n')
  }, 12000)

  it('renders heading, emphasis, lists, table and code as directly editable Markdown', () => {
    const view = render(<Controlled initial={'# Title\n\nA **bold** word.\n\n- one\n- two\n\n| Key | Value |\n|---|---|\n| a | b |\n\n```bash\necho hi\n```\n'} />)
    const editor = screen.getByRole('textbox', { name: label() })
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(editor.querySelector('h1')).toHaveTextContent('Title')
    expect(editor.querySelector('strong')).toHaveTextContent('bold')
    expect(editor.querySelectorAll('li')).toHaveLength(2)
    expect(editor.querySelector('td')).toHaveTextContent('a')
    expect(editor.querySelector('pre code')).toHaveTextContent('echo hi')
    expect(view.container.querySelector('textarea')).not.toBeInTheDocument()
    expect(seen).not.toHaveBeenCalled()
  })

  it('edits through real paste and toolbar events, saves Markdown text and can undo/redo', () => {
    render(<Controlled />)
    const editor = screen.getByRole('textbox', { name: label() })
    paste(editor, 'Hello 中文')
    selectAll(editor)
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expect(editor.querySelector('strong')).toHaveTextContent('Hello 中文')
    fireEvent.click(screen.getByRole('button', { name: 'Heading 2' }))
    expect(editor.querySelector('h2')).toHaveTextContent('Hello 中文')
    expect(seen).toHaveBeenLastCalledWith('## **Hello 中文**')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(editor.querySelector('h2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(editor.querySelector('h2')).toHaveTextContent('Hello 中文')
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    expect(screen.getByRole('textbox', { name: label() })).toHaveValue('## **Hello 中文**')
  })

  it('keeps paragraphs separate after Enter at an unchanged file end without a newline', () => {
    render(<Controlled initial="hello" />)
    const editor = screen.getByRole('textbox', { name: label() })
    selectAll(editor)
    paste(editor, 'hello')
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', keyCode: 13 })
    paste(editor, 'next')
    expect(editor.querySelectorAll('p')).toHaveLength(2)
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    expect(screen.getByRole('textbox', { name: label() })).toHaveValue('hello\n\nnext')
    fireEvent.click(screen.getByRole('tab', { name: 'Formatted' }))
    expect(screen.getByRole('textbox', { name: label() }).querySelectorAll('p')).toHaveLength(2)
  })

  it('creates a list through the actual formatting control', () => {
    render(<Controlled />)
    const editor = screen.getByRole('textbox', { name: label() })
    paste(editor, 'First item')
    fireEvent.click(screen.getByRole('button', { name: 'Bullet list' }))
    expect(editor.querySelector('ul li')).toHaveTextContent('First item')
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    expect(screen.getByRole('textbox', { name: label() })).toHaveValue('- First item')
  })

  it('switches source and formatted views without rewriting an unmodified document', () => {
    const initial = '---\r\nkind: fixture\r\n---\r\n\r\n# Title\r\n\r\nSee [link][r].\r\n\r\n[r]: https://example.invalid\r\n'
    render(<Controlled initial={initial} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    // Browser textarea normalizes displayed newlines, but the controlled source must not be rewritten.
    expect(seen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Formatted' }))
    expect(seen).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: label() }).querySelector('h1')).toHaveTextContent('Title')
  })

  it('reflects actual source edits back into the formatted view', () => {
    render(<Controlled initial="# Initial\n" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    fireEvent.change(screen.getByRole('textbox', { name: label() }), { target: { value: '## Updated\n\n**Bold**\n' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Formatted' }))
    const editor = screen.getByRole('textbox', { name: label() })
    expect(editor.querySelector('h2')).toHaveTextContent('Updated')
    expect(editor.querySelector('strong')).toHaveTextContent('Bold')
  })

  it('keeps untrusted HTML inert, prevents automatic image loads, and preserves it in source', () => {
    const initial = '<script>window.fixtureCompromised=true</script>\n\n<img src="https://example.invalid/beacon" onerror="bad()">\n\n![logo](https://example.invalid/image)\n\n[link](javascript:bad)\n'
    const view = render(<Controlled initial={initial} />)
    expect(view.container.querySelector('script,img,iframe,a[href]')).toBeNull()
    expect(seen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    expect(screen.getByRole('textbox', { name: label() })).toHaveValue(initial)
  })

  it('keeps disabled documents read-only and exposes errors by accessible description', () => {
    render(<RemoteFileEditor absolutePath="/a.md" value="# Read only\n" onChange={seen} disabled error="Fixture conflict" />)
    const editor = screen.getByRole('textbox', { name: label() })
    expect(editor).toHaveAttribute('contenteditable', 'false')
    expect(editor).toHaveAccessibleDescription('Fixture conflict')
    paste(editor, 'must not write')
    expect(seen).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled()
  })

  it.each(['en', 'zh', 'zh-TW', 'jp', 'kr'] as const)('names formatted/source controls in %s', locale => {
    useSettingsStore.setState({ locale })
    render(<Controlled initial="# Title" />)
    expect(screen.getByRole('tab', { name: t('managedResources.files.editor.formatted' as never) })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: t('managedResources.files.editor.source' as never) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('managedResources.files.editor.bold' as never) })).toBeInTheDocument()
  })

  it('detects a shell shebang without requiring a file extension', () => {
    expect(remoteFileLanguage('/bin/fixture', '#!/usr/bin/env bash\necho hi')).toBe('bash')
    expect(remoteFileLanguage('/etc/fixture.conf', 'key=value')).toBe('text')
  })
})
