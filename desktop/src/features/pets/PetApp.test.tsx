import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListItem } from '../../types/session'

const mocks = vi.hoisted(() => ({
  preferences: {
    enabled: true,
    selectedPetId: 'dada-code',
    size: 112,
    showTaskPanel: true,
    collapsed: false,
    motionEnabled: true,
    lastSessionId: 'session-running' as string | null,
  },
  chats: {} as Record<string, any>,
  sessions: [] as SessionListItem[],
  fetchSessions: vi.fn(),
  getChatStatus: vi.fn(),
  updatePetPreferences: vi.fn(),
  initializeDesktopServerUrl: vi.fn(),
  focusSession: vi.fn(),
  hidePet: vi.fn(),
  showContextMenu: vi.fn(),
  dragWindow: vi.fn(),
  setIgnoreMouseEvents: vi.fn(),
  setInteractiveRegions: vi.fn(),
}))

vi.mock('../../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPetPreferences: vi.fn(async () => ({ exists: true, pet: { ...mocks.preferences } })),
    updatePetPreferences: mocks.updatePetPreferences,
  },
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getChatStatus: mocks.getChatStatus,
  },
}))

vi.mock('../../lib/desktopRuntime', () => ({
  initializeDesktopServerUrl: mocks.initializeDesktopServerUrl,
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    pets: {
      list: vi.fn(async () => ({ pets: [], errors: [] })),
      focusSession: mocks.focusSession,
      hide: mocks.hidePet,
      showContextMenu: mocks.showContextMenu,
      dragWindow: mocks.dragWindow,
      setIgnoreMouseEvents: mocks.setIgnoreMouseEvents,
      setInteractiveRegions: mocks.setInteractiveRegions,
    },
  }),
}))

vi.mock('../../stores/sessionStore', () => {
  const useSessionStore = (selector: (state: { sessions: SessionListItem[] }) => unknown) => selector({
    sessions: mocks.sessions,
  })
  useSessionStore.getState = () => ({ fetchSessions: mocks.fetchSessions })
  return { useSessionStore }
})

vi.mock('../../stores/chatStore', () => {
  const useChatStore = (selector: (state: { sessions: Record<string, any> }) => unknown) => selector({
    sessions: mocks.chats,
  })
  return { useChatStore }
})

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, unknown>) => (
    params?.count === undefined ? key : `${key}:${params.count}`
  ),
}))

import { PetApp } from './PetApp'

function session(id: string, title: string, modifiedAt: string): SessionListItem {
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 2,
    projectPath: '/project',
    workDir: '/project',
    workDirExists: true,
  }
}

function chat(chatState: string, preview: string) {
  return {
    chatState,
    connectionState: 'connected',
    connectionSnapshotReady: true,
    historyStatus: 'ready',
    streamingText: '',
    statusVerb: '',
    messages: preview
      ? [{ id: 'reply', type: 'assistant_text', content: preview, timestamp: 1 }]
      : [],
  }
}

function firePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit & { pointerId: number, isPrimary?: boolean },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    isPrimary: { value: init.isPrimary ?? true },
  })
  fireEvent(target, event)
}

describe('PetApp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preferences.enabled = true
    mocks.preferences.selectedPetId = 'dada-code'
    mocks.preferences.size = 112
    mocks.preferences.showTaskPanel = true
    mocks.preferences.collapsed = false
    mocks.preferences.motionEnabled = true
    mocks.preferences.lastSessionId = 'session-running'
    mocks.sessions = [
      session('session-running', 'Build pet window', '2026-07-19T12:01:00Z'),
      session('session-idle', 'Review animation', '2026-07-19T12:00:00Z'),
    ]
    mocks.chats = {
      'session-running': chat('thinking', 'Planning the next animation…'),
      'session-idle': chat('idle', 'The atlas is ready.'),
    }
    mocks.initializeDesktopServerUrl.mockResolvedValue('http://127.0.0.1:3456')
    mocks.fetchSessions.mockResolvedValue(undefined)
    mocks.showContextMenu.mockResolvedValue(true)
    mocks.dragWindow.mockResolvedValue(undefined)
    mocks.getChatStatus.mockImplementation(async (sessionId: string) => ({
      state: sessionId === 'session-running' ? 'thinking' : 'idle',
      activityState: sessionId === 'session-running' ? 'running' : 'idle',
    }))
    mocks.updatePetPreferences.mockImplementation(async (pet) => ({
      ok: true,
      preferences: { pet },
    }))
  })

  afterEach(() => cleanup())

  it('hides the task panel by preference even while work is active', async () => {
    mocks.preferences.showTaskPanel = false
    render(<PetApp />)

    expect(await screen.findByRole('button', { name: 'pet.window.interact' })).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.getChatStatus).toHaveBeenCalledWith('session-running', expect.any(AbortSignal))
    })
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('pet.window.sessionCount:1')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.setInteractiveRegions.mock.calls.at(-1)?.[0]).toHaveLength(2)
    })

    fireEvent.click(screen.getByRole('button', { name: 'pet.window.expandTasks:1' }))
    expect(mocks.updatePetPreferences).toHaveBeenCalledWith({ showTaskPanel: true })
    expect(await screen.findByRole('list')).toBeInTheDocument()
  })

  it('hides the task panel when no task is active even if the preference is enabled', async () => {
    mocks.chats = {
      'session-running': chat('idle', 'The build is done.'),
      'session-idle': chat('idle', 'The atlas is ready.'),
    }
    mocks.getChatStatus.mockResolvedValue({ state: 'idle', activityState: 'idle' })
    render(<PetApp />)

    expect(await screen.findByRole('button', { name: 'pet.window.interact' })).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.getChatStatus).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByText('pet.window.noSessions')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('pet.window.sessionCount:0')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.setInteractiveRegions.mock.calls.at(-1)?.[0]).toHaveLength(1)
    })
  })

  it('hides the whole task surface when an older server reports only completed review markers', async () => {
    mocks.chats = {
      'session-running': chat('idle', 'The build is done.'),
      'session-idle': chat('idle', 'The atlas is ready.'),
    }
    mocks.getChatStatus.mockResolvedValue({ state: 'idle', activityState: 'review' })
    render(<PetApp />)

    expect(await screen.findByRole('button', { name: 'pet.window.interact' })).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.getChatStatus).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByText('Build pet window')).not.toBeInTheDocument()
    expect(screen.queryByText('Review animation')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('pet.window.expandTasks:2')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.setInteractiveRegions.mock.calls.at(-1)?.[0]).toHaveLength(1)
    })
  })

  it('shows only active session work and opens the task from the whole row', async () => {
    render(<PetApp />)

    const runningRow = await screen.findByRole('button', {
      name: 'Build pet window, pet.window.status.running',
    })
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.queryByText('Review animation')).not.toBeInTheDocument()
    expect(screen.queryByText('Planning the next animation…')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pet.window.send' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pet.window.stop' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pet.window.open' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pet.window.closePanel' })).not.toBeInTheDocument()

    await waitFor(() => {
      expect(mocks.getChatStatus).toHaveBeenCalledWith('session-running', expect.any(AbortSignal))
      expect(mocks.getChatStatus).toHaveBeenCalledWith('session-idle', expect.any(AbortSignal))
    })

    fireEvent.click(runningRow)
    expect(mocks.focusSession).toHaveBeenCalledWith('session-running')
  })

  it('hides legacy review sessions while keeping real active work visible', async () => {
    mocks.getChatStatus.mockImplementation(async (sessionId: string) => ({
      state: 'thinking',
      activityState: sessionId === 'session-idle' ? 'review' : 'running',
    }))
    render(<PetApp />)

    await screen.findByRole('button', {
      name: 'Build pet window, pet.window.status.running',
    })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('Review animation')).not.toBeInTheDocument()
  })

  it('shows every active task and returns the card to its badge from the chevron', async () => {
    mocks.sessions = [
      session('session-running', 'Build pet window', '2026-07-19T12:01:00Z'),
      session('session-second', 'Polish animation', '2026-07-19T12:00:00Z'),
    ]
    mocks.chats = {
      'session-running': chat('thinking', 'First preview'),
      'session-second': chat('thinking', 'Second preview'),
    }
    mocks.getChatStatus.mockResolvedValue({ state: 'thinking', activityState: 'running' })
    render(<PetApp />)

    expect(await screen.findByRole('button', {
      name: 'Build pet window, pet.window.status.running',
    })).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: 'Polish animation, pet.window.status.running',
    })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', {
      name: 'pet.window.hideTasks:2',
    }))

    expect(mocks.focusSession).not.toHaveBeenCalled()
    expect(mocks.updatePetPreferences).toHaveBeenCalledWith({ showTaskPanel: false })
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pet.window.expandTasks:2' })).toBeInTheDocument()
  })

  it('hides the card while keeping the mascot and task badge interactive', async () => {
    render(<PetApp />)
    await screen.findByRole('button', {
      name: 'Build pet window, pet.window.status.running',
    })
    await waitFor(() => {
      expect(mocks.setInteractiveRegions).toHaveBeenCalledWith(expect.any(Array))
      expect(mocks.setInteractiveRegions.mock.calls.at(-1)?.[0]).toHaveLength(3)
    })

    fireEvent.click(screen.getByRole('button', {
      name: 'pet.window.hideTasks:1',
    }))

    expect(mocks.updatePetPreferences).toHaveBeenCalledWith({ showTaskPanel: false })
    expect(mocks.hidePet).not.toHaveBeenCalled()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pet.window.expandTasks:1' })).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.setInteractiveRegions.mock.calls.at(-1)?.[0]).toHaveLength(2)
    })
  })

  it('keeps a short mascot pointer gesture as a normal pet interaction', async () => {
    render(<PetApp />)
    const mascot = await screen.findByRole('button', { name: 'pet.window.interact' })
    mascot.setPointerCapture = vi.fn()
    mascot.hasPointerCapture = vi.fn(() => true)
    mascot.releasePointerCapture = vi.fn()

    firePointer(mascot, 'pointerdown', {
      button: 0,
      isPrimary: true,
      pointerId: 7,
      screenX: 100,
      screenY: 100,
    })
    firePointer(mascot, 'pointermove', {
      buttons: 1,
      isPrimary: true,
      pointerId: 7,
      screenX: 103,
      screenY: 102,
    })
    firePointer(mascot, 'pointerup', {
      button: 0,
      isPrimary: true,
      pointerId: 7,
      screenX: 103,
      screenY: 102,
    })
    fireEvent.click(mascot)

    expect(mocks.dragWindow).not.toHaveBeenCalled()
    expect(mocks.updatePetPreferences).not.toHaveBeenCalledWith({ collapsed: true })
    expect(mascot.querySelector('[data-pet-state="waving"]')).toBeInTheDocument()
    expect(mascot.setPointerCapture).toHaveBeenCalledWith(7)
    expect(mascot.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('drags from the whole mascot with pointer capture without triggering its click', async () => {
    render(<PetApp />)
    const mascot = await screen.findByRole('button', { name: 'pet.window.interact' })
    mascot.setPointerCapture = vi.fn()
    mascot.hasPointerCapture = vi.fn(() => true)
    mascot.releasePointerCapture = vi.fn()

    firePointer(mascot, 'pointerdown', {
      button: 0,
      isPrimary: true,
      pointerId: 9,
      clientX: 60,
      clientY: 60,
      screenX: 500,
      screenY: 400,
    })
    firePointer(mascot, 'pointermove', {
      buttons: 1,
      isPrimary: true,
      pointerId: 9,
      clientX: 75,
      clientY: 80,
      screenX: 515,
      screenY: 420,
    })
    fireEvent.mouseLeave(mascot, { relatedTarget: null })

    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(mascot).toHaveAttribute('data-dragging', 'true')
    expect(mascot).toHaveAttribute('data-drag-direction', 'right')
    expect(mascot.querySelector('[data-pet-state="running-right"]')).toBeInTheDocument()
    firePointer(mascot, 'pointerup', {
      button: 0,
      isPrimary: true,
      pointerId: 9,
      clientX: 75,
      clientY: 80,
      screenX: 530,
      screenY: 440,
    })
    fireEvent.click(mascot)

    await waitFor(() => expect(mocks.dragWindow.mock.calls).toEqual([
      [{ phase: 'start', x: 500, y: 400 }],
      [{ phase: 'end', x: 530, y: 440 }],
    ]))
    expect(mascot).toHaveAttribute('data-dragging', 'false')
    expect(mocks.updatePetPreferences).not.toHaveBeenCalledWith({ collapsed: true })
    expect(mascot.setPointerCapture).toHaveBeenCalledWith(9)
    expect(mascot.releasePointerCapture).toHaveBeenCalledWith(9)
  })

  it('closes the whole pet only from its right-click menu without stopping the task', async () => {
    render(<PetApp />)
    await screen.findByRole('button', { name: 'Build pet window, pet.window.status.running' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'pet.window.interact' }))

    await waitFor(() => expect(mocks.showContextMenu).toHaveBeenCalledWith('pet.window.close'))
    await waitFor(() => expect(mocks.updatePetPreferences).toHaveBeenCalledWith({ enabled: false }))
    expect(mocks.hidePet).toHaveBeenCalledTimes(1)
  })

  it('keeps the pet visible when the native right-click menu is dismissed', async () => {
    mocks.showContextMenu.mockResolvedValueOnce(false)
    render(<PetApp />)
    await screen.findByRole('button', { name: 'Build pet window, pet.window.status.running' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'pet.window.interact' }))

    await waitFor(() => expect(mocks.showContextMenu).toHaveBeenCalledTimes(1))
    expect(mocks.updatePetPreferences).not.toHaveBeenCalledWith({ enabled: false })
    expect(mocks.hidePet).not.toHaveBeenCalled()
  })

  it('keeps the pet visible and reports a native menu failure', async () => {
    mocks.showContextMenu.mockRejectedValueOnce(new Error('menu unavailable'))
    render(<PetApp />)
    await screen.findByRole('button', { name: 'Build pet window, pet.window.status.running' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'pet.window.interact' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('pet.window.closeError')
    expect(mocks.updatePetPreferences).not.toHaveBeenCalledWith({ enabled: false })
    expect(mocks.hidePet).not.toHaveBeenCalled()
  })

  it('restores the enabled preference when the native pet window cannot hide', async () => {
    mocks.hidePet.mockRejectedValueOnce(new Error('window unavailable'))
    render(<PetApp />)
    await screen.findByRole('button', { name: 'Build pet window, pet.window.status.running' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'pet.window.interact' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('pet.window.closeError')
    expect(mocks.updatePetPreferences).toHaveBeenNthCalledWith(1, { enabled: false })
    expect(mocks.updatePetPreferences).toHaveBeenNthCalledWith(2, { enabled: true })
  })

  it('keeps the pet visible when disabling it cannot be persisted', async () => {
    mocks.updatePetPreferences.mockRejectedValueOnce(new Error('disk full'))
    render(<PetApp />)
    await screen.findByRole('button', { name: 'Build pet window, pet.window.status.running' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'pet.window.interact' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('pet.window.saveError')
    expect(mocks.hidePet).not.toHaveBeenCalled()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'pet.window.interact' }))
    await waitFor(() => expect(mocks.hidePet).toHaveBeenCalledTimes(1))
  })

  it('reveals a close failure even when the task panel was collapsed', async () => {
    mocks.preferences.collapsed = true
    mocks.updatePetPreferences.mockRejectedValueOnce(new Error('disk full'))
    render(<PetApp />)
    const mascot = await screen.findByRole('button', { name: 'pet.window.interact' })

    fireEvent.contextMenu(mascot)

    expect(await screen.findByRole('alert')).toHaveTextContent('pet.window.saveError')
    expect(mocks.hidePet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', {
      name: 'pet.window.hideTasks:1',
    })).toBeInTheDocument()
  })
})
