import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import fs from 'node:fs/promises'
import path from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { Server as SshServer, type Connection } from 'ssh2'
import { createHostWorkbenchHarness } from '../../../test/hostWorkbenchHarness'
import { useHostSshStore } from '../stores/hostSshStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { RemoteFilesPanel } from '../ui/hosts/RemoteFilesPanel'
import { createFakeSftpTransport } from '../../../../electron/services/managedResources/sftpTestTransport'
import { createSftpService, createTransferService, createRemoteEditService } from '../../../../electron/services/managedResources/sftpService'
import { ELECTRON_IPC_CHANNELS } from '../../../../electron/ipc/channels'
import type { Host } from '../types/resourceTypes'

let fixture: Awaited<ReturnType<typeof createHostWorkbenchHarness>>
let remote: Awaited<ReturnType<typeof createFakeSftpTransport>>
let server: SshServer
let host: Host
const peers = new Set<Connection>()
const session = () => useHostSshStore.getState().byHostId[host.id]!
const request = () => ({ jobId: randomUUID(), connectionId: session().connectionId!, generation: session().generation, remotePath: '/' })
beforeEach(async () => {
  useSettingsStore.setState({ locale: 'en' })
  useHostSshStore.getState().teardownAll()
  fixture = await createHostWorkbenchHarness()
  remote = await createFakeSftpTransport()
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  server = new SshServer({ hostKeys: [key] }, client => {
    peers.add(client)
    client.on('error', () => {})
    client.on('close', () => peers.delete(client))
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'DIRECTORY_JOIN_FAKE') context.accept()
      else context.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const channel = accept()
      channel.on('pty', acceptPty => acceptPty())
      channel.on('shell', acceptShell => { acceptShell() })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const saved = await fixture.host.hostManagement.saveHost({
    name: 'Directory fixture', address: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'fixture',
    auth: { type: 'password', credentialId: null }, credential: { storage: 'vault', secret: { kind: 'ssh-password', password: 'DIRECTORY_JOIN_FAKE' } },
    tagIds: [], initialDirectory: '/', applications: [], notes: '',
  })
  if (!saved.ok) throw new Error('Fixture host create failed')
  host = saved.data
  await useHostSshStore.getState().start(host, 80, 24)
  await waitFor(() => expect(session().challenge).not.toBeNull(), { timeout: 6000 })
  await useHostSshStore.getState().answer(host.id, 'trust')
  await waitFor(() => expect(session().status).toBe('ready'), { timeout: 6000 })
  const resolveSession = (input: { connectionId: string; ownerId: string }) => {
    const actual = fixture.services.sshService.getInternalsForOwner(input.connectionId, input.ownerId)
    if (!actual) throw new Error('UNAUTHORIZED_OWNER')
    return { ...actual, client: remote.resolveSession(input).client }
  }
  const sftp = createSftpService({ resolveSession, tempDir: fixture.tempDir })
  fixture.services.sftpService.dispose()
  fixture.services.transferService.dispose()
  fixture.services.sftpService = sftp
  fixture.services.transferService = createTransferService({ resolveSession, sftpService: sftp, localPathService: fixture.services.localPathService })
  fixture.services.remoteEditService = createRemoteEditService({ resolveSession, sftpService: sftp, localPathService: fixture.services.localPathService })
})
afterEach(async () => {
  cleanup()
  if (host && session()?.connectionId) await useHostSshStore.getState().disconnect(host.id)
  useHostSshStore.getState().teardownAll()
  fixture?.services.sftpService.dispose()
  fixture?.services.transferService.dispose()
  await fixture?.dispose()
  for (const peer of peers) peer.end()
  peers.clear()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await remote?.dispose()
})

describe('folder UI -> DesktopHost -> preload -> IPC -> services -> isolated filesystem', () => {
  it('uploads a real picked folder and downloads it with structure intact through DOM actions', async () => {
    const source = path.join(fixture.tempDir, 'project')
    await fs.mkdir(path.join(source, 'nested', 'empty-dir'), { recursive: true })
    await fs.writeFile(path.join(source, '.profile'), 'export LANG=C\n')
    await fs.writeFile(path.join(source, 'nested', 'empty.txt'), '')
    await fs.writeFile(path.join(source, 'nested', 'large.bin'), Buffer.alloc(3 * 1024 * 1024 + 1, 65))
    fixture.setImportPath(source)
    render(<RemoteFilesPanel host={host} />)
    fireEvent.click(screen.getByTestId('remote-upload-folder'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Transfer completed'), { timeout: 8000 })
    expect((await remote.readFile('/project/.profile')).toString()).toBe('export LANG=C\n')
    expect(fixture.calls).toContain(ELECTRON_IPC_CHANNELS.mrTransferUploadFolder)
    const destination = path.join(fixture.tempDir, 'download')
    await fs.mkdir(destination)
    fixture.setImportPath(destination)
    const row = await screen.findByRole('button', { name: 'Download folder: project' })
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Transfer completed'), { timeout: 8000 })
    expect(await fs.readFile(path.join(destination, 'project', '.profile'), 'utf8')).toBe('export LANG=C\n')
    expect((await fs.stat(path.join(destination, 'project', 'nested', 'empty-dir'))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(destination, 'project', 'nested', 'large.bin'))).size).toBe(3 * 1024 * 1024 + 1)
    expect(fixture.calls).toContain(ELECTRON_IPC_CHANNELS.mrTransferDownloadFolder)
    expect(document.body.textContent).not.toContain(fixture.tempDir)
  }, 15000)

  it('edits and saves an existing Shell file twice through the real DOM and IPC', async () => {
    await remote.seedFile('/editable.sh', '# initial fixture\n')
    render(<RemoteFilesPanel host={host} />)
    fireEvent.click(await screen.findByRole('button', { name: /^editable.sh/ }))
    const editor = await screen.findByRole('textbox', { name: 'Remote text editor' })
    const save = screen.getByRole('button', { name: 'Save' })
    for (const text of ['# edited 中文\n', '# second save\n']) {
      fireEvent.change(editor, { target: { value: text } })
      fireEvent.click(save)
      await waitFor(() => expect(save).toBeDisabled())
      expect((await remote.readFile('/editable.sh')).toString()).toBe(text)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    }
    expect(fixture.calls.filter(channel => channel === ELECTRON_IPC_CHANNELS.mrRemoteEditSave)).toHaveLength(2)
  })

  it('cancels a pending native folder picker before any folder is transmitted', async () => {
    const source = path.join(fixture.tempDir, 'cancelled')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'must-stay.txt'), 'fixture')
    fixture.setImportPath(source)
    const release = fixture.holdNextOpen()
    render(<RemoteFilesPanel host={host} />)
    fireEvent.click(screen.getByTestId('remote-upload-folder'))
    await waitFor(() => expect(fixture.openCount).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
    await waitFor(() => expect(fixture.calls).toContain(ELECTRON_IPC_CHANNELS.mrTransferCancel))
    await act(async () => { release() })
    await waitFor(() => expect(screen.getByTestId('remote-upload-folder')).not.toBeDisabled())
    expect(await fs.readdir(remote.remoteRoot)).toEqual([])
  })

  it('rejects renderer-supplied native paths in both folder channels before showing the picker', async () => {
    const input = { ...request(), localRoot: fixture.tempDir }
    await expect(fixture.host.hostManagement.transferUploadFolder(input)).rejects.toThrow('Invalid Electron IPC payload')
    await expect(fixture.host.hostManagement.transferDownloadFolder(input)).rejects.toThrow('Invalid Electron IPC payload')
    expect(fixture.openCount).toBe(0)
  })
})
