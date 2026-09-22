import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { HostDetail } from '../ui/hosts/HostDetail'
import { normalizeRemoteDirectory } from '../ui/hosts/RemoteFilesPanel'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
const address = () => screen.getByRole('textbox', { name: 'Paste an absolute remote directory' })
const names = () => screen.getByRole('searchbox', { name: 'Search files and folders' })
async function openFiles() {
  render(<HostDetail />)
  fireEvent.click(screen.getByTestId('host-files-tab'))
  await within(screen.getByTestId('remote-file-browser')).findByRole('list')
}
async function go(path: string) {
  fireEvent.change(address(), { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: 'Go' }))
}
beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
  await h.remote.seedFile('/srv/中文 folder/.bashrc', 'export TEST=1\n')
  await h.remote.seedFile('/srv/中文 folder/Service.LOG', 'fixture log\n')
})
afterEach(async () => { cleanup(); await h?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('remote directory navigation through HostDetail, DesktopHost and SFTP', () => {
  it('jumps to a pasted path and filters hidden/Unicode filenames without running a shell', async () => {
    await openFiles()
    await go('/srv//中文 folder/./')
    await waitFor(() => expect(address()).toHaveValue('/srv/中文 folder'))
    const list = screen.getByTestId('remote-file-browser')
    expect(await within(list).findByRole('button', { name: /\.bashrc/ })).toBeVisible()
    const calls = h.fixture.calls.length
    fireEvent.change(names(), { target: { value: 'service.log' } })
    expect(within(list).queryByRole('button', { name: /\.bashrc/ })).not.toBeInTheDocument()
    expect(within(list).getByRole('button', { name: /Service.LOG/ })).toBeVisible()
    expect(h.fixture.calls.length).toBe(calls)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(within(list).getByRole('button', { name: /\.bashrc/ })).toBeVisible()
    expect(h.commands).toEqual([])
  })

  it('keeps the last valid listing after an invalid or missing directory', async () => {
    await openFiles()
    await go('/srv/中文 folder')
    await waitFor(() => expect(address()).toHaveValue('/srv/中文 folder'))
    await within(screen.getByTestId('remote-file-browser')).findByRole('button', { name: /Service.LOG/ })
    const calls = h.fixture.calls.length
    await go('C:\\not-linux')
    expect(screen.getByRole('alert')).toHaveTextContent('absolute Linux directory')
    expect(h.fixture.calls.length).toBe(calls)
    await go('/path-that-does-not-exist')
    await waitFor(() => expect(screen.getByRole('alert')).not.toHaveTextContent('absolute Linux directory'))
    expect(within(screen.getByTestId('remote-file-browser')).getByRole('button', { name: /Service.LOG/ })).toBeVisible()
  })

  it('does not let a late previous navigation overwrite a newer result', async () => {
    await openFiles()
    const release = h.fixture.holdNextSave('desktop:managed-resources:sftp-list' as never)
    await go('/srv/中文 folder')
    await go(h.root + '/conf')
    await waitFor(() => expect(address()).toHaveValue(h.root + '/conf'))
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 80)) })
    expect(address()).toHaveValue(h.root + '/conf')
    expect(within(screen.getByTestId('remote-file-browser')).getByRole('button', { name: /app.conf/ })).toBeVisible()
  })

  it('normalizes directory segments without accepting relative paths or commands', () => {
    expect(normalizeRemoteDirectory('/a/../b//')).toBe('/b')
    expect(normalizeRemoteDirectory('~/b')).toBeNull()
    expect(normalizeRemoteDirectory('/a\0b')).toBeNull()
    expect(normalizeRemoteDirectory('/' + 'x'.repeat(4096))).toBeNull()
  })
})
