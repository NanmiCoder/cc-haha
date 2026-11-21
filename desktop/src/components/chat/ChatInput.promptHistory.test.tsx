import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { useRef } from 'react'
import { TextSelection } from 'prosemirror-state'
import { promptHistoryApi } from '@/api/promptHistory'
import { clearComposerPromptHistoryCacheForTesting } from '@/hooks/useComposerPromptHistory'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspaceChatContextStore } from '@/stores/workspaceChatContextStore'
import { textOffsetToPmPos } from './composerEditor'
import {
  getComposerElement,
  getComposerText,
  getComposerView,
  setComposerSelection,
  setComposerText,
  stubRangeGeometry,
} from './composerTestUtils'
import { MentionComposer, type MentionComposerHandle } from './MentionComposer'

const mocks = vi.hoisted(() => ({
  promptHistoryList: vi.fn(),
  promptHistoryAppend: vi.fn(),
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getMessages: vi.fn(),
  getGitInfo: vi.fn(),
  getSlashCommands: vi.fn(),
  getRepositoryContext: vi.fn(),
  listAgents: vi.fn(),
  listReferences: vi.fn(),
  listSkills: vi.fn(),
  listSkillCommands: vi.fn(),
  searchFiles: vi.fn(),
  browseFiles: vi.fn(),
  wsSend: vi.fn(),
}))

vi.mock('@/api/promptHistory', () => ({
  promptHistoryApi: {
    list: mocks.promptHistoryList,
    append: mocks.promptHistoryAppend,
  },
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    create: mocks.createSession,
    delete: vi.fn(),
    list: mocks.listSessions,
    getMessages: mocks.getMessages,
    getGitInfo: mocks.getGitInfo,
    invalidateGitInfo: vi.fn(),
    getSlashCommands: mocks.getSlashCommands,
    getRepositoryContext: mocks.getRepositoryContext,
    createRepositoryBranch: vi.fn(),
    getRecentProjects: vi.fn(async () => ({ projects: [] })),
  },
}))

vi.mock('../../api/agents', () => ({
  agentsApi: { list: mocks.listAgents },
}))

vi.mock('../../api/skills', () => ({
  skillsApi: {
    list: mocks.listSkills,
    commands: mocks.listSkillCommands,
  },
}))

vi.mock('../../api/composerReferences', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/composerReferences')>(),
  composerReferencesApi: { list: mocks.listReferences },
}))

vi.mock('../../api/filesystem', () => ({
  filesystemApi: {
    search: mocks.searchFiles,
    browse: mocks.browseFiles,
  },
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn((_id: string, handler: (state: string) => void) => {
      handler('connected')
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    send: mocks.wsSend,
    clearHandlers: vi.fn(),
  },
}))

vi.mock('@/api/voice', () => ({
  voiceApi: {
    catalog: vi.fn(async () => ({
      supported: false,
      providers: [],
      preferences: { enabled: false, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto', correctionEnabled: false, correctionProviderId: null, correctionModelId: null },
      limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 },
      correction: { defaultTarget: null, target: null },
    })),
    transcribe: vi.fn(),
    providerStatus: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    removeAssets: vi.fn(),
  },
}))

vi.mock('@/features/voiceInput/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/voiceInput/recorder')>()),
  isVoiceCaptureSupported: vi.fn(() => false),
  startRecording: vi.fn(),
}))

vi.mock('../controls/PermissionModeSelector', () => ({
  PermissionModeSelector: () => <div data-testid="permission-selector" />,
}))

vi.mock('../controls/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}))

import { ChatInput } from './ChatInput'
import { EmptySession } from '@/pages/EmptySession'

function dispatchEditorKeyDown(init: KeyboardEventInit) {
  const editor = getComposerElement()
  act(() => {
    fireEvent.keyDown(editor, init)
  })
}

describe('MentionComposer boundary and replaceContent handle', () => {
  let restoreRangeGeometry: (() => void) | null = null

  beforeEach(() => {
    restoreRangeGeometry = stubRangeGeometry()
  })

  afterEach(() => {
    restoreRangeGeometry?.()
    restoreRangeGeometry = null
  })

  it('reports up/down boundaries accurately for empty, multi-paragraph, and range selections', () => {
    let handle: MentionComposerHandle | null = null
    function Harness() {
      const ref = useRef<MentionComposerHandle>(null)
      handle = ref.current
      return (
        <MentionComposer
          ref={(instance) => {
            ;(ref as React.MutableRefObject<MentionComposerHandle | null>).current = instance
            handle = instance
          }}
          value=""
          mentions={[]}
          onChange={() => {}}
        />
      )
    }

    render(<Harness />)
    expect(handle).not.toBeNull()
    expect(handle!.isSelectionAtBoundary('up')).toBe(true)
    expect(handle!.isSelectionAtBoundary('down')).toBe(true)

    act(() => {
      handle!.replaceContent('first line\nsecond line\nthird line', [], 'start')
    })
    expect(handle!.getSelectionOffsets()).toEqual({ start: 0, end: 0 })
    expect(handle!.isSelectionAtBoundary('up')).toBe(true)
    expect(handle!.isSelectionAtBoundary('down')).toBe(false)

    // Middle paragraph: neither up nor down boundary.
    setComposerSelection(14)
    expect(handle!.isSelectionAtBoundary('up')).toBe(false)
    expect(handle!.isSelectionAtBoundary('down')).toBe(false)

    // Last paragraph: down boundary only.
    act(() => {
      handle!.replaceContent('first line\nsecond line\nthird line', [], 'end')
    })
    expect(handle!.getSelectionOffsets()).toEqual({ start: 33, end: 33 })
    expect(handle!.isSelectionAtBoundary('up')).toBe(false)
    expect(handle!.isSelectionAtBoundary('down')).toBe(true)

    // Non-collapsed range selection: never treated as boundary.
    const view = getComposerView()
    act(() => {
      const from = textOffsetToPmPos(view.state.doc, 0)
      const to = textOffsetToPmPos(view.state.doc, 5)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    })
    expect(handle!.isSelectionAtBoundary('up')).toBe(false)
    expect(handle!.isSelectionAtBoundary('down')).toBe(false)
  })
})

describe('ChatInput prompt history navigation', () => {
  const sessionId = 'session-history-nav'
  const initialChatState = useChatStore.getInitialState()
  const initialSessionState = useSessionStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialUIState = useUIStore.getInitialState()
  const initialSettingsState = useSettingsStore.getInitialState()
  const initialWorkspaceContextState = useWorkspaceChatContextStore.getInitialState()
  let restoreRangeGeometry: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    clearComposerPromptHistoryCacheForTesting()
    restoreRangeGeometry = stubRangeGeometry()

    mocks.promptHistoryList.mockResolvedValue({ entries: [] })
    mocks.promptHistoryAppend.mockResolvedValue({ ok: true })
    mocks.listAgents.mockResolvedValue({ activeAgents: [] })
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [] })
    mocks.listSkills.mockResolvedValue({ skills: [] })
    mocks.listSkillCommands.mockResolvedValue({ commands: [] })
    mocks.searchFiles.mockResolvedValue({ files: [] })
    mocks.browseFiles.mockResolvedValue({ entries: [] })
    mocks.getGitInfo.mockResolvedValue({ isGit: false, branch: null, workDir: '/repo/app' })
    mocks.getSlashCommands.mockResolvedValue({ commands: [] })
    mocks.getRepositoryContext.mockResolvedValue({ state: 'not_git', workDir: '/repo/app' })

    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
    useTabStore.setState(initialTabState, true)
    useUIStore.setState(initialUIState, true)
    useSettingsStore.setState(initialSettingsState, true)
    useWorkspaceChatContextStore.setState(initialWorkspaceContextState, true)

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'History Session',
        workDir: '/repo/app',
        projectRoot: '/repo/app',
        projectPath: '-repo-app',
        createdAt: new Date(1).toISOString(),
        modifiedAt: new Date(2).toISOString(),
        messageCount: 3,
        workDirExists: true,
        workspaceState: 'available',
      }],
      activeSessionId: sessionId,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'History Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...useChatStore.getState().getSession(sessionId),
          chatState: 'idle',
          connectionState: 'connected',
          slashCommands: [{ name: 'compact', description: 'Compact conversation' }],
          messages: [
            { id: 'u1', type: 'user_text', content: 'first prompt', timestamp: 10 },
            { id: 'a1', type: 'assistant_text', content: 'reply 1', timestamp: 11 },
            { id: 'u2', type: 'user_text', content: 'second line 1\nsecond line 2', timestamp: 20 },
            { id: 'a2', type: 'assistant_text', content: 'reply 2', timestamp: 21 },
            { id: 'u3', type: 'user_text', content: '/compact', timestamp: 30 },
          ],
        },
      },
    })
  })

  afterEach(() => {
    restoreRangeGeometry?.()
    restoreRangeGeometry = null
    clearComposerPromptHistoryCacheForTesting()
  })

  it('cycles Up/Down through session history and older project history while preserving the live draft', async () => {
    mocks.promptHistoryList.mockResolvedValue({
      entries: [
        { display: '/compact', timestamp: 30, sessionId },
        { display: 'older tui prompt', timestamp: 5, sessionId: 'tui-session' },
      ],
    })

    render(<ChatInput />)
    setComposerText('my wip draft')

    // ArrowUp 1 -> most recent turn (`/compact`), without opening the slash menu.
    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('/compact')
    expect(document.querySelector('[role="listbox"]')).toBeNull()

    // ArrowUp 2 -> multiline turn (`second line 1\nsecond line 2`), caret placed at start (offset 0).
    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('second line 1\nsecond line 2')
    expect(getComposerView().state.selection.from).toBe(1)

    // ArrowUp 3 -> immediately advances past multiline entry because caret is on line 1.
    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('first prompt')

    // Wait for background project-history warm-up to extend the snapshot.
    await waitFor(() => {
      expect(promptHistoryApi.list).toHaveBeenCalledTimes(1)
    })

    // ArrowUp 4 -> steps into cross-session TUI history from history.jsonl.
    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('older tui prompt')

    // ArrowDown steps back through newer entries (placing caret at end) and restores the live draft.
    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('first prompt')

    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('second line 1\nsecond line 2')
    const view = getComposerView()
    expect(view.state.selection.from).toBe(view.state.doc.content.size - 1)

    // Because caret landed at the end (last line), ArrowDown immediately advances again.
    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('/compact')

    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('my wip draft')
  })

  it('does not hijack ArrowUp/ArrowDown when cursor is inside a multiline draft or modifier/IME/menu is active', () => {
    render(<ChatInput />)
    setComposerText('line one\nline two', 12) // caret on line 2

    // Caret on line 2 -> ArrowUp must NOT trigger history navigation.
    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('line one\nline two')

    // Caret on line 1 with Shift/Meta/IME -> must NOT trigger history navigation.
    setComposerSelection(2)
    dispatchEditorKeyDown({ key: 'ArrowUp', shiftKey: true })
    dispatchEditorKeyDown({ key: 'ArrowUp', metaKey: true })
    dispatchEditorKeyDown({ key: 'ArrowUp', keyCode: 229 })
    expect(getComposerText()).toBe('line one\nline two')

    // Typing `/` opens the slash menu -> ArrowUp navigates the menu, not prompt history.
    setComposerText('/comp')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('/comp')
  })

  it('resets history navigation when the user edits a recalled prompt so ArrowDown does not discard edits', () => {
    render(<ChatInput />)

    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('/compact')

    // User modifies the recalled prompt.
    setComposerText('/compact keep summary')

    // ArrowDown must now be a no-op (not restore the old empty draft).
    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('/compact keep summary')
  })

  it('records newly sent prompts for immediate ArrowUp recall and persists via promptHistoryApi.append', async () => {
    render(<ChatInput />)
    setComposerText('brand new desktop prompt')

    dispatchEditorKeyDown({ key: 'Enter' })
    await waitFor(() => {
      expect(getComposerText()).toBe('')
    })

    expect(promptHistoryApi.append).toHaveBeenCalledWith({
      display: 'brand new desktop prompt',
      project: '/repo/app',
      sessionId,
    })

    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('brand new desktop prompt')
  })
})

describe('EmptySession prompt history navigation', () => {
  let restoreRangeGeometry: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    clearComposerPromptHistoryCacheForTesting()
    restoreRangeGeometry = stubRangeGeometry()

    mocks.promptHistoryList.mockResolvedValue({
      entries: [
        { display: 'empty session latest prompt', timestamp: 20, sessionId: 'prev-1' },
        { display: 'empty session older prompt', timestamp: 10, sessionId: 'prev-0' },
      ],
    })
    mocks.promptHistoryAppend.mockResolvedValue({ ok: true })
    mocks.listAgents.mockResolvedValue({ activeAgents: [] })
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [] })
    mocks.listSkills.mockResolvedValue({ skills: [] })
    mocks.listSkillCommands.mockResolvedValue({ commands: [] })
    mocks.getRepositoryContext.mockResolvedValue({ state: 'not_git', workDir: '/repo/app' })
  })

  afterEach(() => {
    restoreRangeGeometry?.()
    restoreRangeGeometry = null
    clearComposerPromptHistoryCacheForTesting()
  })

  it('recalls persisted project history with ArrowUp and restores draft with ArrowDown', async () => {
    render(<EmptySession initialWorkDir="/repo/app" visible />)
    setComposerText('new task draft')

    dispatchEditorKeyDown({ key: 'ArrowUp' })
    await waitFor(() => {
      expect(getComposerText()).toBe('empty session latest prompt')
    })
    expect(promptHistoryApi.list).toHaveBeenCalledWith(expect.objectContaining({
      project: '/repo/app',
      sessionOnly: false,
    }))

    dispatchEditorKeyDown({ key: 'ArrowUp' })
    expect(getComposerText()).toBe('empty session older prompt')

    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('empty session latest prompt')

    dispatchEditorKeyDown({ key: 'ArrowDown' })
    expect(getComposerText()).toBe('new task draft')
  })
})
