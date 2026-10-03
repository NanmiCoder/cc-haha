import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import type { DesktopHost, MigrationPreview, MigrationStatus } from '@/lib/desktopHost/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { DataMigrationSettings } from './DataMigrationSettings'

const preview: MigrationPreview = {
  id: 'migration-fixture', sourceDir: '/fixture/original', targetDir: '/fixture/new', files: 4, bytes: 1024, activeTasks: 2,
}
const copying: MigrationStatus = {
  id: preview.id, sourceDir: preview.sourceDir, targetDir: preview.targetDir,
  stage: 'copying', files: 2, totalFiles: 4, bytes: 512, totalBytes: 1024, cancellable: true,
}

let host: DesktopHost
let progressListener: ((status: MigrationStatus) => void) | undefined
const prepare = vi.fn()
const start = vi.fn()
const status = vi.fn()
const cancel = vi.fn()
const unlisten = vi.fn()
const open = vi.fn()
const openPath = vi.fn()
const setAppMode = vi.fn()
const onProgress = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  progressListener = undefined
  useSettingsStore.setState({ locale: 'en' })
  prepare.mockResolvedValue(preview)
  start.mockResolvedValue(undefined)
  status.mockResolvedValue(null)
  cancel.mockResolvedValue(undefined)
  open.mockResolvedValue(preview.targetDir)
  openPath.mockResolvedValue(undefined)
  onProgress.mockImplementation(async (listener: (value: MigrationStatus) => void) => {
    progressListener = listener
    return unlisten
  })
  host = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: { ...browserHost.capabilities, appMode: true, dialogs: true, shell: true },
    dialogs: { ...browserHost.dialogs, open },
    shell: { ...browserHost.shell, openPath },
    appMode: { ...browserHost.appMode, set: setAppMode, migration: { prepare, start, status, cancel, onProgress } },
  }
  window.desktopHost = host
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'desktopHost')
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

async function chooseAndPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'Migrate Existing Data…' }))
  return screen.findByRole('dialog', { name: 'Migrate data and restart?' })
}

describe('Data migration settings', () => {
  it('uses the native picker, previews exact paths and task impact, then starts only after confirmation', async () => {
    const busy = vi.fn()
    render(<DataMigrationSettings environmentControlled={false} onBusyChange={busy} />)
    const dialog = await chooseAndPreview()
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: 'Choose a migration destination' })
    expect(prepare).toHaveBeenCalledWith(preview.targetDir)
    expect(within(dialog).getByText(preview.sourceDir)).toBeInTheDocument()
    expect(within(dialog).getByText(preview.targetDir)).toBeInTheDocument()
    expect(within(dialog).getByText('4 files · 1 KB')).toBeInTheDocument()
    expect(within(dialog).getByText('2 running tasks will be stopped.')).toBeInTheDocument()
    expect(within(dialog).getByText(/Close other Claude Code/)).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
    expect(setAppMode).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate and Restart' }))
    await waitFor(() => expect(start).toHaveBeenCalledWith(preview.id))
    expect(screen.getByRole('dialog', { name: 'Data migration in progress' })).toBeInTheDocument()
    expect(busy).toHaveBeenLastCalledWith(true)
    expect(setAppMode).not.toHaveBeenCalled()
  })

  it('allows cancellation of the preview without stopping tasks or changing the mode', async () => {
    render(<DataMigrationSettings environmentControlled={false} />)
    const dialog = await chooseAndPreview()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(setAppMode).not.toHaveBeenCalled()
  })

  it('does not prepare a migration when the native picker is cancelled', async () => {
    open.mockResolvedValue(null)
    render(<DataMigrationSettings environmentControlled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Migrate Existing Data…' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Migrate Existing Data…' })).not.toBeDisabled())
    expect(prepare).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('shows preflight rejection and keeps migration and mode changes unstarted', async () => {
    prepare.mockRejectedValue(new Error('Target directory must be empty'))
    render(<DataMigrationSettings environmentControlled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Migrate Existing Data…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Target directory must be empty')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
    expect(setAppMode).not.toHaveBeenCalled()
  })

  it('disables migration for externally controlled roots and hides it in browsers', () => {
    const { unmount } = render(<DataMigrationSettings environmentControlled />)
    expect(screen.getByRole('button', { name: 'Migrate Existing Data…' })).toBeDisabled()
    expect(screen.getByText(/Remove CLAUDE_CONFIG_DIR/)).toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
    unmount()
    Reflect.deleteProperty(window, 'desktopHost')
    render(<DataMigrationSettings environmentControlled={false} />)
    expect(screen.queryByText('Migrate existing data')).not.toBeInTheDocument()
  })

  it('restores a running job on mount, shows progress and blocks dismissal while committing', async () => {
    status.mockResolvedValue(copying)
    render(<DataMigrationSettings environmentControlled={false} />)
    const dialog = await screen.findByRole('dialog', { name: 'Data migration in progress' })
    expect(within(dialog).getByRole('progressbar', { name: 'Copying data…' })).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('button', { name: 'Migrate Existing Data…' })).toBeDisabled()
    await act(async () => progressListener?.({ ...copying, stage: 'verifying', files: 4, bytes: 1024 }))
    expect(within(dialog).getByRole('progressbar', { name: 'Verifying copied data…' })).not.toHaveAttribute('aria-valuenow')
    await act(async () => progressListener?.({ ...copying, stage: 'committing', cancellable: false }))
    expect(within(dialog).getByRole('button', { name: 'Cancel migration' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog).toBeInTheDocument()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('requests cancellation once and waits for the host terminal status before restoring controls', async () => {
    status.mockResolvedValue(copying)
    const busy = vi.fn()
    render(<DataMigrationSettings environmentControlled={false} onBusyChange={busy} />)
    const dialog = await screen.findByRole('dialog', { name: 'Data migration in progress' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel migration' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(copying.id))
    expect(within(dialog).getByRole('button', { name: 'Cancel migration' })).toBeDisabled()
    expect(dialog).toBeInTheDocument()
    await act(async () => progressListener?.({ ...copying, stage: 'cancelled', cancellable: false }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/Migration cancelled/)).toBeInTheDocument()
    expect(busy).toHaveBeenLastCalledWith(false)
  })

  it('ignores a stale initial poll after a newer progress event', async () => {
    let resolveStatus!: (value: MigrationStatus | null) => void
    status.mockImplementationOnce(() => new Promise<MigrationStatus | null>(resolve => { resolveStatus = resolve }))
    render(<DataMigrationSettings environmentControlled={false} />)
    await act(async () => progressListener?.(copying))
    await act(async () => resolveStatus(null))
    expect(screen.getByRole('dialog', { name: 'Data migration in progress' })).toBeInTheDocument()
  })

  it('keeps the migration barrier when the start response and status connection both disconnect', async () => {
    start.mockRejectedValue(new Error('IPC connection lost'))
    status.mockRejectedValue(new Error('IPC connection lost'))
    render(<DataMigrationSettings environmentControlled={false} />)
    const dialog = await chooseAndPreview()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate and Restart' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('IPC connection lost')
    expect(screen.getByRole('dialog', { name: 'Data migration in progress' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Migrate Existing Data…' })).toBeDisabled()
    expect(setAppMode).not.toHaveBeenCalled()
  })

  it('polls after the event connection fails and cleans up polling on unmount', async () => {
    vi.useFakeTimers()
    onProgress.mockRejectedValue(new Error('event transport unavailable'))
    status.mockResolvedValueOnce(null).mockResolvedValue(copying)
    const { unmount } = render(<DataMigrationSettings environmentControlled={false} />)
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByRole('dialog', { name: 'Data migration in progress' })).toBeInTheDocument()
    expect(status).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('recovers a completion receipt after restart and offers original/new folders and CLI guidance', async () => {
    status.mockResolvedValue({ ...copying, stage: 'completed', cancellable: false })
    const { unmount } = render(<DataMigrationSettings environmentControlled={false} />)
    expect(await screen.findByText('Data migration completed')).toBeInTheDocument()
    expect(screen.getByText(/before manually cleaning up/)).toBeInTheDocument()
    expect(screen.getByText(/A separately launched CLI/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Original Directory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open New Directory' }))
    await waitFor(() => expect(openPath.mock.calls).toEqual([[preview.sourceDir], [preview.targetDir]]))
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('shows a failed background job without changing the original mode', async () => {
    status.mockResolvedValue({ ...copying, stage: 'failed', error: 'Source changed during copying', cancellable: false })
    render(<DataMigrationSettings environmentControlled={false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Source changed during copying')
    expect(screen.getByText('Migration failed. The original data directory is kept.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(setAppMode).not.toHaveBeenCalled()
  })
})
