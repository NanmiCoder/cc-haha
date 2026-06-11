import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'

const mocks = vi.hoisted(() => ({
  saveWorkspaceFileMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    saveWorkspaceFile: mocks.saveWorkspaceFileMock,
  },
}))

import {
  useWorkspacePanelStore,
  type WorkspacePreviewTab,
} from '../../stores/workspacePanelStore'
import { WorkspaceEditor } from './WorkspaceEditor'

/**
 * RTL tests for WorkspaceEditor (Phase 2 task 15).
 *
 * Strategy: drive the component with synthetic preview tabs so we don't
 * have to mount a full WorkspacePanel; mock only the save endpoint.
 *
 * **Validates Properties: 8** (dirty markers, save aborts close, unsupported
 * encoding fallback, conflict banner gates).
 *
 * _Requirements: 1.1-1.8, 4.1-4.6_
 */

function makeTab(overrides: Partial<WorkspacePreviewTab> = {}): WorkspacePreviewTab {
  return {
    id: 'file:src/app.ts',
    path: 'src/app.ts',
    kind: 'file',
    title: 'app.ts',
    content: 'export const x = 1\n',
    state: 'ok',
    language: 'typescript',
    size: 19,
    ...overrides,
  }
}

describe('WorkspaceEditor', () => {
  const initialState = useWorkspacePanelStore.getInitialState()

  beforeEach(() => {
    mocks.saveWorkspaceFileMock.mockReset()
    mocks.saveWorkspaceFileMock.mockResolvedValue({
      ok: true,
      hash: 'a'.repeat(64),
      bytes: 19,
      timestamp: Date.now(),
    })
    useWorkspacePanelStore.setState(initialState, true)
  })

  afterEach(() => {
    useWorkspacePanelStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  it('initializes the buffer with detected encoding and line ending', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" tab={tab} />)

    await waitFor(() => {
      const buffer = useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]
      expect(buffer).toBeDefined()
      expect(buffer?.encoding).toBe('utf-8')
      expect(buffer?.lineEnding).toBe('LF')
      expect(buffer?.isDirty).toBe(false)
    })

    expect(screen.getByTestId('workspace-editor-path').textContent?.trim()).toBe('src/app.ts')
  })

  it('renders the unsupported-encoding fallback for non-UTF-8 buffers', async () => {
    const tab = makeTab({
      // String containing a stray 0xE9 (Latin-1 é); when re-encoded to bytes
      // it produces a sequence that detectEncoding rejects as unsupported.
      content: 'naive \u0080 buffer',
    })
    // Force the encoder to produce an invalid sequence by stubbing TextEncoder
    // with a mock that returns the lone 0x80 byte.
    const realEncoder = global.TextEncoder
    class StubEncoder {
      encoding = 'utf-8'
      encode(): Uint8Array {
        return new Uint8Array([0x80, 0x61])
      }
      encodeInto(): { read: number; written: number } {
        return { read: 0, written: 0 }
      }
    }
    // @ts-expect-error — narrow override for the duration of the test
    global.TextEncoder = StubEncoder

    render(<WorkspaceEditor sessionId="s1" tab={tab} />)

    await waitFor(() => {
      expect(screen.queryByTestId('workspace-editor-unsupported')).toBeTruthy()
    })

    global.TextEncoder = realEncoder
  })

  it('shows the dirty marker after a buffer edit', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" tab={tab} />)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]).toBeDefined()
    })

    act(() => {
      useWorkspacePanelStore.getState().setBufferState(tab.id, 'export const x = 2\n')
    })

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]?.isDirty).toBe(true)
    })

    await waitFor(() => {
      expect(screen.getByTestId('workspace-editor-path').textContent).toContain('●')
    })
  })

  it('opens the unsaved-changes modal when closing a dirty buffer', async () => {
    const tab = makeTab()
    const onClose = vi.fn()
    render(<WorkspaceEditor sessionId="s1" tab={tab} onClose={onClose} />)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]).toBeDefined()
    })
    act(() => {
      useWorkspacePanelStore.getState().setBufferState(tab.id, 'edited')
    })

    fireEvent.click(screen.getByTestId('workspace-editor-close'))

    expect(screen.getByTestId('unsaved-changes-modal')).toBeTruthy()
    expect(screen.getByTestId('unsaved-changes-cancel')).toBeTruthy()
    expect(screen.getByTestId('unsaved-changes-save')).toBeTruthy()
    expect(screen.getByTestId('unsaved-changes-discard')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes immediately for a clean buffer without showing the modal', async () => {
    const tab = makeTab()
    const onClose = vi.fn()
    render(<WorkspaceEditor sessionId="s1" tab={tab} onClose={onClose} />)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('workspace-editor-close'))

    expect(screen.queryByTestId('unsaved-changes-modal')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the modal interactive when no save is in flight (Cancel/Discard enabled)', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" tab={tab} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]).toBeDefined()
    })
    act(() => {
      useWorkspacePanelStore.getState().setBufferState(tab.id, 'edited')
    })

    fireEvent.click(screen.getByTestId('workspace-editor-close'))
    expect((screen.getByTestId('unsaved-changes-cancel') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('unsaved-changes-discard') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('unsaved-changes-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders the conflict banner when buffer.conflict is set', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" tab={tab} />)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]).toBeDefined()
    })

    act(() => {
      useWorkspacePanelStore.getState().applyExternalSave(tab.id, {
        source: 'user',
        hash: 'c'.repeat(64),
        timestamp: Date.now(),
      })
    })

    expect(screen.getByTestId('workspace-conflict-banner')).toBeTruthy()
    // Clean buffer -> single Reload button.
    expect(screen.getByTestId('conflict-reload')).toBeTruthy()
    expect(screen.queryByTestId('conflict-keep-mine')).toBeNull()
  })

  it('shows three banner buttons when the buffer is dirty at conflict time', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" tab={tab} />)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().bufferStateByTabId[tab.id]).toBeDefined()
    })

    act(() => {
      useWorkspacePanelStore.getState().setBufferState(tab.id, 'edited')
      useWorkspacePanelStore.getState().applyExternalSave(tab.id, {
        source: 'user',
        hash: 'c'.repeat(64),
        timestamp: Date.now(),
      })
    })

    expect(screen.getByTestId('conflict-reload')).toBeTruthy()
    expect(screen.getByTestId('conflict-keep-mine')).toBeTruthy()
    expect(screen.getByTestId('conflict-open-view')).toBeTruthy()
  })
})
