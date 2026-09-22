import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { RemoteFilesPanel } from '../ui/hosts/RemoteFilesPanel'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
beforeEach(async () => {
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
})
afterEach(async () => { cleanup(); await h?.dispose() })

// Gate only the SFTP transport stream: all bytes, tokens, jobs, polling and IPC
// still use production code. No service state is seeded or mocked.
async function holdReads() {
  const holder = await h.fixture.services.sftpService.ensureSftp(h.ssh().connectionId!, 'window:99')
  const original = holder.sftp.createReadStream.bind(holder.sftp)
  let released = false
  const pending: Array<() => void> = []
  holder.sftp.createReadStream = ((...args: Parameters<typeof original>) => {
    const source = original(...args)
    const gate = new Transform({ transform(chunk, _encoding, done) {
      if (released) done(null, chunk)
      else pending.push(() => done(null, chunk))
    } })
    source.on('error', (error: Error) => gate.destroy(error))
    gate.on('close', () => source.destroy())
    source.pipe(gate)
    return gate as unknown as ReturnType<typeof original>
  })
  return () => {
    released = true
    for (const resolve of pending.splice(0)) resolve()
    holder.sftp.createReadStream = original
  }
}
const jobs = () => h.fixture.services.transferService.listJobs('window:99')
const finished = () => jobs().every(job => ['completed', 'failed', 'cancelled'].includes(job.state))

describe('remote transfer title through DOM, DesktopHost, IPC and actual transfer service', () => {
  it('rotates actual simultaneous upload/download jobs and cancels only the displayed download', async () => {
    const bytes = Buffer.alloc(2 * 1024 ** 2, 65)
    const source = path.join(h.fixture.tempDir, 'upload archive.bin')
    const destination = path.join(h.fixture.tempDir, 'download-target.bin')
    await fs.writeFile(source, bytes)
    await h.remote.seedFile(h.root + '/download.bin', bytes)
    const release = await holdReads()
    const view = render(<RemoteFilesPanel host={h.host} />)
    try {
      await screen.findByRole('button', { name: /^Download$/ })
      h.fixture.setImportPath(source)
      fireEvent.click(screen.getByRole('button', { name: /^Upload$/ }))
      await waitFor(() => expect(jobs()[0]?.state).toBe('verifying'))
      const uploadId = jobs()[0]!.id
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Verifying file integrity'))
      h.fixture.setExportPath(destination)
      fireEvent.click(screen.getByRole('button', { name: /^Download$/ }))
      await waitFor(() => expect(jobs()).toHaveLength(2))
      const downloadId = jobs().find(job => job.direction === 'download')!.id
      const title = screen.getByTestId('remote-files-header')
      await waitFor(() => expect(within(title).getByRole('status')).toHaveAttribute('data-transfer-id', downloadId), { timeout: 5000 })
      fireEvent.mouseEnter(screen.getByRole('group', { name: 'File transfer activity' }))
      expect(within(title).getByRole('status')).toHaveTextContent('Downloaddownload.bin')
      fireEvent.click(within(title).getByRole('button', { name: 'Cancel transfer' }))
      await waitFor(() => expect(jobs().find(job => job.id === downloadId)?.state).toBe('cancelled'))
      expect(jobs().find(job => job.id === uploadId)?.state).toBe('verifying')
      await act(async () => { release() })
      await waitFor(() => expect(finished()).toBe(true))
      fireEvent.click(within(title).getByRole('button', { name: 'Previous transfer' }))
      await waitFor(() => expect(within(title).getByRole('status')).toHaveTextContent('Transfer completed'))
      const uploaded = await h.remote.readFile(h.root + '/upload archive.bin')
      expect(createHash('sha256').update(uploaded).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(await fs.stat(destination).catch(() => null)).toBeNull()
      expect(h.ssh().status).toBe('ready')
      expect(document.body.textContent).not.toContain(h.fixture.tempDir)
    } finally {
      view.unmount()
      release()
      await waitFor(() => expect(finished()).toBe(true))
    }
  }, 12000)

  it('enforces three transfers, frees only the cancelled slot and cancels remaining tasks on unmount', async () => {
    await h.remote.seedFile(h.root + '/download.bin', Buffer.alloc(1024 ** 2, 66))
    const release = await holdReads()
    const view = render(<RemoteFilesPanel host={h.host} />)
    try {
      const button = await screen.findByRole('button', { name: /^Download$/ })
      for (let i = 0; i < 3; i++) {
        await waitFor(() => expect(button).toBeEnabled())
        h.fixture.setExportPath(path.join(h.fixture.tempDir, `target-${i}.bin`))
        fireEvent.click(button)
        await waitFor(() => expect(jobs()).toHaveLength(i + 1))
      }
      expect(button).toBeDisabled()
      expect(screen.getByRole('button', { name: /^Upload$/ })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
      await waitFor(() => expect(button).toBeEnabled())
      expect(jobs().filter(job => job.state === 'cancelled')).toHaveLength(1)
      expect(jobs().filter(job => job.state === 'in_progress')).toHaveLength(2)
      view.unmount()
      await waitFor(() => expect(jobs().every(job => job.state === 'cancelled')).toBe(true))
      expect(h.ssh().status).toBe('ready')
    } finally { view.unmount(); release(); await waitFor(() => expect(finished()).toBe(true)) }
  })

  it('shows failure in the title without overwriting the existing file or keeping a cancel action', async () => {
    const source = path.join(h.fixture.tempDir, 'existing.bin')
    await fs.writeFile(source, 'new fixture')
    await h.remote.seedFile(h.root + '/existing.bin', 'keep fixture')
    h.fixture.setImportPath(source)
    render(<RemoteFilesPanel host={h.host} />)
    fireEvent.click(screen.getByRole('button', { name: /^Upload$/ }))
    const title = screen.getByTestId('remote-files-header')
    await waitFor(() => expect(within(title).getByRole('status')).toHaveAttribute('data-transfer-state', 'failed'))
    expect(within(title).getByRole('status')).toHaveTextContent('already exists')
    expect(within(title).queryByRole('button', { name: 'Cancel transfer' })).toBeNull()
    expect((await h.remote.readFile(h.root + '/existing.bin')).toString()).toBe('keep fixture')
  })

  it('places selecting, completion and cancellation in the title instead of the footer', async () => {
    const source = path.join(h.fixture.tempDir, 'header-file.txt')
    await fs.writeFile(source, 'header transport fixture\n')
    h.fixture.setImportPath(source)
    const release = h.fixture.holdNextOpen()
    render(<RemoteFilesPanel host={h.host} />)
    fireEvent.click(screen.getByRole('button', { name: /^Upload$/ }))
    try {
      await waitFor(() => expect(h.fixture.openCount).toBe(1))
      const title = screen.getByTestId('remote-files-header')
      expect(within(title).getByRole('status')).toHaveTextContent('Selecting or preparing files')
      expect(within(title).getByRole('button', { name: 'Cancel transfer' })).toBeEnabled()
      await act(async () => { release() })
      await waitFor(() => expect(within(title).getByRole('status')).toHaveTextContent('Transfer completed'))
      expect(within(title).getByRole('status')).toHaveTextContent('header-file.txt')
      expect((await h.remote.readFile(h.root + '/header-file.txt')).toString()).toBe('header transport fixture\n')
      await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1))
      expect(document.body.textContent).not.toContain(h.fixture.tempDir)
    } finally { await act(async () => { release() }) }
  })
})
