import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsApi } from '@/api/agents'
import { composerReferencesApi } from '@/api/composerReferences'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getComposerElement, getComposerText, setComposerText } from './composerTestUtils'
import { UserMessageEditor } from './UserMessageEditor'
import type { UserMessageEditDraft } from './userMessageEdit'

const DRAFT: UserMessageEditDraft = {
  text: 'Fix the bug',
  attachments: [
    { id: 'a', type: 'file', name: 'notes.md', path: '/repo/notes.md', sendable: true },
  ],
  sessionReferences: [],
}

const SKILL = {
  kind: 'skill' as const,
  id: 'frontend-design',
  name: 'frontend-design',
  displayName: 'Frontend Design',
  description: 'Build distinctive UIs',
  source: 'skills',
  modelText: 'Use the Skill tool with skill: "frontend-design" for this request.',
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
  return { ...props, textbox: screen.getByRole('textbox', { name: 'Edited message' }) }
}

describe('UserMessageEditor', () => {
  beforeEach(() => {
    vi.spyOn(composerReferencesApi, 'list').mockResolvedValue({ skills: [SKILL], plugins: [] })
    vi.spyOn(agentsApi, 'list').mockResolvedValue({ activeAgents: [], allAgents: [] } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'enter' })
    useSessionStore.setState({ sessions: [] })
  })

  it('opens focused on the draft with the caret at the end', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { textbox } = renderEditor()

    expect(getComposerText()).toBe('Fix the bug')
    expect(document.activeElement).toBe(textbox)
    const selection = window.getSelection()!
    expect(selection.anchorNode?.textContent).toBe('Fix the bug')
    expect(selection.anchorOffset).toBe('Fix the bug'.length)
  })

  it('submits the edited draft on Enter but not on Shift+Enter', () => {
    useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'enter' })
    const { textbox, onSubmit, onDraftChange } = renderEditor()

    setComposerText('Fix the signup bug')
    expect(onDraftChange).toHaveBeenLastCalledWith({ ...DRAFT, text: 'Fix the signup bug' })

    // Shift+Enter is a newline, not a send.
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(getComposerText()).toBe('Fix the signup bug\n')

    setComposerText('Fix the signup bug')
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
    setComposerText('   ')
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

  it('lets the user drop the Agent Team switch from the edited message', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { onDraftChange, onSubmit } = renderEditor({ initialDraft: { ...DRAFT, agentTeam: true } })
    expect(screen.getByTestId('agent-team-chip').textContent).toBe('Agent Teams')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Agent Teams' }))
    expect(screen.queryByTestId('agent-team-chip')).toBeNull()
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ agentTeam: false }))

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ agentTeam: false }))
  })

  describe('slash commands and skills', () => {
    function seedSession() {
      useChatStore.setState({
        sessions: {
          'session-1': {
            slashCommands: [{ name: 'review', description: 'Review the current changes', kind: 'command' }],
          } as never,
        },
      })
    }

    it('shows the pill a reloaded skill prompt had and sends it again with its own text', () => {
      useSettingsStore.setState({ locale: 'en' })
      const { onSubmit } = renderEditor({
        initialDraft: {
          text: '@Frontend Design make a landing page',
          attachments: [],
          sessionReferences: [],
          mentions: [{
            kind: 'skill', id: 'frontend-design', label: 'Frontend Design', modelText: SKILL.modelText,
            path: '', isDirectory: false, tokenOrdinal: 0,
          }],
        },
      })

      expect(getComposerElement().querySelector('[data-mention-kind="skill"]')?.textContent).toContain('Frontend Design')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(vi.mocked(onSubmit).mock.calls[0]![0].mentions).toEqual([expect.objectContaining({ kind: 'skill', id: 'frontend-design' })])
    })

    it('offers slash commands on "/" and keeps the picked command as plain text', async () => {
      useSettingsStore.setState({ locale: 'en' })
      useSessionStore.setState({ sessions: [{ id: 'session-1', workDir: '/repo' } as never] })
      seedSession()
      const { onDraftChange } = renderEditor({ sessionId: 'session-1', initialDraft: { text: '', attachments: [], sessionReferences: [] } })

      setComposerText('/rev', 4)
      const option = await screen.findByRole('option', { name: /\/review/ })
      fireEvent.click(option)

      await waitFor(() => expect(getComposerText()).toBe('/review '))
      expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: '/review ' }))
      expect(screen.queryByRole('option')).toBeNull()
    })

    it('does not offer /btw, which only the main composer turns into a side chat', async () => {
      useSettingsStore.setState({ locale: 'en' })
      useSessionStore.setState({ sessions: [{ id: 'session-1', workDir: '/repo' } as never] })
      useChatStore.setState({
        sessions: { 'session-1': { slashCommands: [{ name: 'bt-notes', description: 'Notes', kind: 'command' }] } as never },
      })
      renderEditor({ sessionId: 'session-1', initialDraft: { text: '', attachments: [], sessionReferences: [] } })

      setComposerText('/bt', 3)
      // The control option proves the menu opened for this filter before /btw is ruled out.
      await screen.findByRole('option', { name: /\/bt-notes/ })
      expect(screen.queryByRole('option', { name: /\/btw/ })).toBeNull()
    })

    it('turns a skill picked from the slash menu into a pill', async () => {
      useSettingsStore.setState({ locale: 'en' })
      useSessionStore.setState({ sessions: [{ id: 'session-1', workDir: '/repo' } as never] })
      seedSession()
      const { onDraftChange } = renderEditor({ sessionId: 'session-1', initialDraft: { text: '', attachments: [], sessionReferences: [] } })

      setComposerText('/front', 6)
      fireEvent.click(await screen.findByRole('option', { name: /frontend-design|Frontend Design/ }))

      await waitFor(() => expect(getComposerElement().querySelector('[data-mention-kind="skill"]')).not.toBeNull())
      expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
        mentions: [expect.objectContaining({ kind: 'skill', id: 'frontend-design', modelText: SKILL.modelText })],
      }))
    })

    it('offers skills on "@" and navigates the menu from the keyboard without sending', async () => {
      useSettingsStore.setState({ locale: 'en', chatSendBehavior: 'enter' })
      useSessionStore.setState({ sessions: [{ id: 'session-1', workDir: '/repo' } as never] })
      seedSession()
      const { textbox, onSubmit, onDraftChange } = renderEditor({ sessionId: 'session-1', initialDraft: { text: 'use ', attachments: [], sessionReferences: [] } })

      setComposerText('use @fro', 8)
      await screen.findByRole('option', { name: /Frontend Design/ })

      // Enter picks the highlighted skill; it must not also send the edit.
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await waitFor(() => expect(getComposerElement().querySelector('[data-mention-kind="skill"]')).not.toBeNull())
      expect(onSubmit).not.toHaveBeenCalled()
      expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
        mentions: [expect.objectContaining({ kind: 'skill', id: 'frontend-design' })],
      }))

      // With the menu closed, Enter sends again.
      fireEvent.keyDown(textbox, { key: 'Enter' })
      expect(onSubmit).toHaveBeenCalledOnce()
    })

    it('closes an open menu with Escape instead of cancelling the edit', async () => {
      useSettingsStore.setState({ locale: 'en' })
      useSessionStore.setState({ sessions: [{ id: 'session-1', workDir: '/repo' } as never] })
      seedSession()
      const { textbox, onCancel } = renderEditor({ sessionId: 'session-1', initialDraft: { text: '', attachments: [], sessionReferences: [] } })

      setComposerText('/rev', 4)
      await screen.findByRole('option', { name: /\/review/ })
      fireEvent.keyDown(textbox, { key: 'Escape' })
      await act(async () => { await Promise.resolve() })

      expect(screen.queryByRole('option')).toBeNull()
      expect(onCancel).not.toHaveBeenCalled()
      fireEvent.keyDown(textbox, { key: 'Escape' })
      expect(onCancel).toHaveBeenCalledOnce()
    })

    it('does not offer the composer-only commands that act on the composer', async () => {
      useSettingsStore.setState({ locale: 'en' })
      useSessionStore.setState({ sessions: [{ id: 'session-1', workDir: '/repo' } as never] })
      seedSession()
      renderEditor({ sessionId: 'session-1', initialDraft: { text: '', attachments: [], sessionReferences: [] } })

      setComposerText('/model', 6)
      await act(async () => { await Promise.resolve() })

      expect(screen.queryByRole('option', { name: /^\/model/ })).toBeNull()
    })
  })
})
