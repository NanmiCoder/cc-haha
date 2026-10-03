import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { UserMessageEditor } from './UserMessageEditor'
import type { UserMessageEditDraft } from './userMessageEdit'

const DRAFT: UserMessageEditDraft = {
  text: 'Fix the bug',
  attachments: [
    { id: 'a', type: 'file', name: 'notes.md', path: '/repo/notes.md', sendable: true },
  ],
  sessionReferences: [],
}

function renderEditor(overrides: Partial<Parameters<typeof UserMessageEditor>[0]> = {}) {
  const props = {
    initialDraft: DRAFT,
    submitting: false,
    disabled: false,
    onDraftChange: vi.fn(),
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
  render(<UserMessageEditor {...props} />)
  return { ...props, textbox: screen.getByRole('textbox', { name: 'Edited message' }) as HTMLTextAreaElement }
}

describe('UserMessageEditor', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'enter' })
  })

  it('opens focused on the draft with the caret at the end', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { textbox } = renderEditor()

    expect(textbox.value).toBe('Fix the bug')
    expect(document.activeElement).toBe(textbox)
    expect(textbox.selectionStart).toBe('Fix the bug'.length)
  })

  it('submits the edited draft on Enter but not on Shift+Enter', () => {
    useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'enter' })
    const { textbox, onSubmit, onDraftChange } = renderEditor()

    fireEvent.change(textbox, { target: { value: 'Fix the signup bug' } })
    expect(onDraftChange).toHaveBeenLastCalledWith({ ...DRAFT, text: 'Fix the signup bug' })

    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith({ ...DRAFT, text: 'Fix the signup bug' })
  })

  it('does not submit the Enter that confirms an IME composition', () => {
    useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'enter' })
    const { textbox, onSubmit } = renderEditor()

    fireEvent.compositionStart(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.compositionEnd(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter', keyCode: 229 })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('follows the modifier+Enter send setting', () => {
    useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'modifierEnter' })
    const { textbox, onSubmit } = renderEditor()

    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true })
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('cancels on Escape without submitting', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { textbox, onCancel, onSubmit } = renderEditor()

    fireEvent.keyDown(textbox, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps editor keystrokes from reaching the message list scroll handler', () => {
    useSettingsStore.setState({ locale: 'en' })
    const listKeyDown = vi.fn()
    render(
      <div onKeyDown={listKeyDown}>
        <UserMessageEditor
          initialDraft={DRAFT}
          submitting={false}
          disabled={false}
          onDraftChange={vi.fn()}
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />
      </div>,
    )

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edited message' }), { key: 'ArrowUp' })
    expect(listKeyDown).not.toHaveBeenCalled()
  })

  it('removes an attachment chip from the draft', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { onDraftChange } = renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }))

    expect(onDraftChange).toHaveBeenLastCalledWith({ ...DRAFT, attachments: [] })
  })

  it('disables send for an empty draft and while the session cannot take an edit', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { textbox, onSubmit } = renderEditor({
      initialDraft: { text: 'x', attachments: [], sessionReferences: [] },
    })
    fireEvent.change(textbox, { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables send when the session is busy', () => {
    useSettingsStore.setState({ locale: 'en' })
    renderEditor({ disabled: true })

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says how many attachments can no longer be resent', () => {
    useSettingsStore.setState({ locale: 'en' })
    renderEditor({
      initialDraft: {
        ...DRAFT,
        attachments: [...DRAFT.attachments, { id: 'b', type: 'file', name: 'gone.pdf', sendable: false }],
      },
    })

    expect(screen.getByText('1 attachment(s) can no longer be read and will be left out when resending.')).toBeTruthy()
  })
})
