import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import editorStyles from './remoteFileEditor.css?inline'

import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { useHostSshStore } from '../../stores/hostSshStore'
import type { ManagedRemoteEditSnapshot, ManagedSftpEntry, ManagedTransferJob } from '../../api/hostManagementApi'
import type { Host, HostManagementEvent } from '../../types/resourceTypes'
import { RemoteFilesPanel } from './RemoteFilesPanel'

const host: Host = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  name: 'Fixture host',
  address: '127.0.0.1',
  port: 22,
  username: 'fixture',
  auth: { type: 'password', credentialId: null },
  tagIds: [],
  initialDirectory: '/home/fixture',
  applications: [],
  notes: '',
}

const fileEntry: ManagedSftpEntry = {
  name: 'notes.txt',
  type: 'file',
  size: 6,
  mtimeMs: 1,
  mode: 0o100644,
  uid: 1000,
  gid: 1000,
  absolutePath: '/home/fixture/notes.txt',
}

const dirEntry: ManagedSftpEntry = {
  name: 'logs',
  type: 'directory',
  size: 0,
  mtimeMs: 1,
  mode: 0o040755,
  uid: 1000,
  gid: 1000,
  absolutePath: '/home/fixture/logs',
}

function snapshot(text = 'hello\n', revision = 'rev-1', generation = 1): ManagedRemoteEditSnapshot {
  return {
    edit: {
      id: '33333333-3333-4333-8333-333333333333',
      connectionId: '22222222-2222-4222-8222-222222222222',
      generation,
      absolutePath: fileEntry.absolutePath,
      baseRevision: revision,
      baseSha256: 'a'.repeat(64),
      baseSize: text.length,
      baseMtimeMs: 1,
      text,
      hasBom: false,
      dirty: false,
      openedAt: 1,
    },
    metadata: { size: text.length, mtimeMs: 1, mode: 0o100644, lineEnding: 'lf', hasBom: false },
  }
}

function completedJob(direction: 'upload' | 'download', remotePath: string): ManagedTransferJob {
  return {
    id: crypto.randomUUID(),
    connectionId: '22222222-2222-4222-8222-222222222222',
    generation: 1,
    direction,
    remotePath,
    size: 8,
    transferred: 8,
    state: 'completed',
    error: null,
    checksum: 'b'.repeat(64),
    startedAt: 1,
    finishedAt: 2,
  }
}

function installFixture() {
  const listeners = new Set<(event: HostManagementEvent) => void>()
  const sftpList = vi.fn(async (_connectionId: string, _generation: number, absolutePath: string) => ({
    ok: true as const,
    data: {
      parent: {
        name: absolutePath === '/' ? '/' : absolutePath.split('/').pop()!,
        type: 'directory' as const,
        size: 0,
        mtimeMs: 1,
        mode: 0o040755,
        uid: 1000,
        gid: 1000,
        absolutePath,
      },
      entries: absolutePath === '/home/fixture' ? [dirEntry, fileEntry] : [],
    },
  }))
  const remoteEditOpen = vi.fn(async () => ({ ok: true as const, data: snapshot() }))
  const remoteEditSave = vi.fn(async (_id: string, _base: string, text: string) => ({ ok: true as const, data: snapshot(text, 'rev-2') }))
  const remoteEditClose = vi.fn(async () => ({ ok: true as const, data: { ok: true as const } }))
  const transferStartUpload = vi.fn(async (_job: string, _connection: string, _generation: number, remotePath: string) => ({
    ok: true as const,
    data: completedJob('upload', remotePath),
  }))
  const transferStartDownload = vi.fn(async (_job: string, _connection: string, _generation: number, remotePath: string) => ({
    ok: true as const,
    data: completedJob('download', remotePath),
  }))

  const hostManagement = {
    ...browserHost.hostManagement,
    async onEvent(listener: (event: HostManagementEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async createConnection() {
      return { ok: true as const, data: { connectionId: '22222222-2222-4222-8222-222222222222', generation: 1 } }
    },
    async startConnection() {
      for (const listener of listeners) {
        listener({
          type: 'connection-state',
          connectionId: '22222222-2222-4222-8222-222222222222',
          generation: 1,
          status: 'ready',
        })
      }
      return { ok: true as const, data: undefined }
    },
    async disconnect() { return { ok: true as const, data: undefined } },
    sftpList,
    remoteEditOpen,
    remoteEditSave,
    remoteEditClose,
    async mintUploadToken() {
      return {
        ok: true as const,
        data: {
          token: '44444444-4444-4444-8444-444444444444',
          absolutePath: 'C:\\safe-staging\\deadbeef__picked.txt',
          expiresAt: Date.now() + 60_000,
          purpose: 'upload-source' as const,
        },
      }
    },
    async mintDownloadToken() {
      return {
        ok: true as const,
        data: {
          token: '55555555-5555-4555-8555-555555555555',
          absolutePath: 'C:\\safe-staging\\feedface__notes.txt',
          expiresAt: Date.now() + 60_000,
          purpose: 'download-target' as const,
        },
      }
    },
    transferStartUpload,
    transferStartDownload,
    async transferCancel() { return { ok: true as const, data: { ok: true as const } } },
    async revokeLocalToken() { return { ok: true as const, data: { ok: true as const } } },
  }
  ;(window as any).desktopHost = { ...browserHost, hostManagement }
  return { sftpList, remoteEditOpen, remoteEditSave, remoteEditClose, transferStartUpload, transferStartDownload }
}

beforeEach(async () => {
  useSettingsStore.setState({ locale: 'en' })
  useHostSshStore.getState().teardownAll()
})

afterEach(() => {
  cleanup()
  useHostSshStore.getState().teardownAll()
  ;(window as any).desktopHost = undefined
})

describe('M4 RemoteFilesPanel production entry', () => {
  it('reaches directory listing and remote edit/save from a real SSH store action and DOM events', async () => {
    const fixture = installFixture()
    await useHostSshStore.getState().start(host, 80, 24)
    render(<RemoteFilesPanel host={host} />)

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument())
    expect(fixture.sftpList).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222', 1, '/home/fixture',
    )

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const editor = await screen.findByRole('textbox', { name: /remote text editor/i })
    expect(editor).toHaveValue('hello\n')
    fireEvent.change(editor, { target: { value: 'changed\n' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(fixture.remoteEditSave).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333', 'rev-1', 'changed\n',
    ))
    expect(editor).toHaveValue('changed\n')
  })

  it('keeps the file list and editor in independent side-by-side panes', async () => {
    installFixture()
    await useHostSshStore.getState().start(host, 80, 24)
    render(<RemoteFilesPanel host={host} />)
    await screen.findByText('notes.txt')
    const split = screen.getByTestId('remote-files-split')
    const files = screen.getByTestId('remote-file-browser')
    const editorPane = screen.getByTestId('remote-file-editor')
    expect(files.parentElement).toBe(split)
    expect(editorPane.parentElement).toBe(split)
    expect(split).toHaveClass('grid', 'min-h-0')
    expect(screen.getByRole('list')).toHaveClass('overflow-y-auto', 'min-h-0')
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const editor = await screen.findByRole('textbox', { name: /remote text editor/i })
    expect(editorPane).toContainElement(editor)
    expect(files).not.toContainElement(editor)
    expect(editor).toHaveAttribute('spellcheck', 'false')
    // The syntax editor uses an overlay, not a flex textarea. Assert the same
    // bounded/resizing invariant from the stylesheet actually imported by it.
    const style = document.createElement('style')
    style.textContent = editorStyles
    document.head.appendChild(style)
    try {
      expect(getComputedStyle(editor).resize).toBe('none')
      expect(getComputedStyle(editor).position).toBe('absolute')
      expect(getComputedStyle(editor).overflow).toBe('auto')
      expect(editor.parentElement).toHaveClass('flex-1', 'min-h-0')
    } finally { style.remove() }
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /remote text editor/i })).not.toBeInTheDocument())
    expect(screen.getByTestId('remote-file-editor')).toBeInTheDocument()
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
  })

  it('uploads the native-picked staging token using the selected basename and downloads through the same panel', async () => {
    const fixture = installFixture()
    await useHostSshStore.getState().start(host, 80, 24)
    render(<RemoteFilesPanel host={host} />)
    await screen.findByText('notes.txt')

    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(fixture.transferStartUpload).toHaveBeenCalled())
    expect(fixture.transferStartUpload.mock.calls[0]?.[3]).toBe('/home/fixture/picked.txt')

    fireEvent.click(screen.getByRole('button', { name: /^download$/i }))
    await waitFor(() => expect(fixture.transferStartDownload).toHaveBeenCalled())
    expect(fixture.transferStartDownload.mock.calls[0]?.[3]).toBe('/home/fixture/notes.txt')
    expect(await screen.findByText('Transfer completed.')).toBeInTheDocument()
  })

  it('does not let a late progress response replace completion while the local token is being released', async () => {
    const fixture = installFixture()
    await useHostSshStore.getState().start(host, 80, 24)
    const done = { ok: true as const, data: completedJob('upload', '/home/fixture/picked.txt') }
    let finishUpload!: (value: typeof done) => void
    let finishPoll!: (value: typeof done) => void
    let release!: () => void
    fixture.transferStartUpload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve }))
    const api = window.desktopHost!.hostManagement
    const poll = vi.spyOn(api, 'transferGet').mockImplementation(() => new Promise(resolve => { finishPoll = resolve }))
    vi.spyOn(api, 'revokeLocalToken').mockImplementation(() => new Promise(resolve => { release = () => resolve({ ok: true, data: { ok: true } }) }))
    render(<RemoteFilesPanel host={host} />)
    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    try {
      await waitFor(() => expect(poll).toHaveBeenCalled())
      await act(async () => { finishUpload(done) })
      expect(screen.getByRole('status')).toHaveTextContent('Transfer completed.')
      await act(async () => { finishPoll({ ...done, data: { ...done.data, state: 'in_progress', transferred: 1 } }) })
      expect(screen.getByRole('status')).toHaveTextContent('Transfer completed.')
    } finally {
      await act(async () => { release?.() })
      vi.restoreAllMocks()
    }
  })

  it('keeps a dirty draft visible when SSH disconnects', async () => {
    installFixture()
    await useHostSshStore.getState().start(host, 80, 24)
    render(<RemoteFilesPanel host={host} />)
    await screen.findByText('notes.txt')
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const editor = await screen.findByRole('textbox', { name: /remote text editor/i })
    fireEvent.change(editor, { target: { value: 'unsaved draft' } })

    useHostSshStore.setState(state => ({
      byHostId: {
        ...state.byHostId,
        [host.id]: { ...state.byHostId[host.id]!, status: 'closed', connectionId: null },
      },
    }))

    await screen.findByText(/unsaved draft is kept locally/i)
    expect(screen.getByRole('textbox', { name: /remote text editor/i })).toHaveValue('unsaved draft')
  })
})
