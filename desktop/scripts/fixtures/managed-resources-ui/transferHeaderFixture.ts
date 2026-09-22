import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import type { BrowserWindow } from 'electron'
import type { SftpService, TransferService } from '../../../electron/services/managedResources/sftpService'
import type { FakeSftpTransport } from '../../../electron/services/managedResources/sftpTestTransport'

type Controls = {
  clickExpression: (expression: string) => Promise<void>
  waitFor: (expression: string, label: string, timeout?: number) => Promise<void>
}

/** Actual native clicks -> preload -> IPC -> transfer service; only SFTP is a gated fixture. */
export async function verifyTransferHeader(win: BrowserWindow, controls: Controls, transport: FakeSftpTransport, sftpService: SftpService, transfers: TransferService, sandbox: string, output: string, selections: string[]) {
  const owner = `window:${win.id}`
  const previous = transfers.listJobs(owner)
  assert(previous.length > 0, 'run after native folder transfer fixture')
  const connectionId = previous[0]!.connectionId
  const { sftp } = await sftpService.ensureSftp(connectionId, owner)
  const original = sftp.createReadStream.bind(sftp)
  const pending: Array<() => void> = []
  let released = false
  sftp.createReadStream = ((...args: Parameters<typeof original>) => {
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
  const release = () => {
    released = true
    for (const resolve of pending.splice(0)) resolve()
    sftp.createReadStream = original
  }
  const [width, height] = win.getSize()
  const priorIds = new Set(previous.map(job => job.id))
  const jobs = () => transfers.listJobs(owner).filter(job => !priorIds.has(job.id))
  const source = path.join(sandbox, 'transfer-header-upload')
  const destination = path.join(sandbox, 'transfer-header-download')
  const bytes = Buffer.alloc(1024 ** 2, 77)
  await fs.mkdir(source)
  await fs.mkdir(destination)
  await fs.writeFile(path.join(source, 'payload.bin'), bytes)
  const status = 'document.querySelector("[data-testid=remote-transfer-header] [role=status]")'
  const namedButton = (label: string) => `Array.from(document.querySelectorAll('[data-testid=remote-transfer-header] button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)})`
  try {
    selections.push(source)
    await controls.clickExpression('document.querySelector("[data-testid=remote-upload-folder]")')
    await controls.waitFor(`${status}?.getAttribute('data-transfer-state') === 'verifying'`, 'upload verifies in title', 10000)
    assert.equal(jobs().length, 1)
    const uploadId = jobs()[0]!.id
    selections.push(destination)
    await controls.clickExpression("Array.from(document.querySelectorAll('[data-testid=remote-file-browser] button')).find(button => button.getAttribute('aria-label') === window.m2Smoke.label('managedResources.transfer.downloadFolder') + ': native-folder')")
    await controls.waitFor(`Boolean(${namedButton('Next transfer')})`, 'two native transfer tasks')
    // This Runner disables Windows animations. Respect that initial preference,
    // then use the real Resume control to explicitly enable automatic cycling.
    if (await win.webContents.executeJavaScript(`Boolean(${namedButton('Resume transfer rotation')})`)) {
      await controls.clickExpression(namedButton('Resume transfer rotation'))
    }
    // Adding a task changes header height. Keep the real pointer and keyboard
    // focus outside its pause-on-hover/focus region before timing rotation.
    await controls.clickExpression("Array.from(document.querySelectorAll('input')).find(input => input.getAttribute('aria-label') === window.m2Smoke.label('managedResources.files.directoryPath'))")
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    try {
      await controls.waitFor(`${status}?.getAttribute('data-transfer-id') !== ${JSON.stringify(uploadId)}`, 'native automatic rotation', 6500)
    } catch (failure) {
      const diagnostic = await win.webContents.executeJavaScript(`({
        focused: document.activeElement?.outerHTML,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        hovered: document.querySelector('[data-testid=remote-transfer-header]')?.matches(':hover'),
        header: document.querySelector('[data-testid=remote-files-header]')?.outerHTML
      })`)
      await fs.writeFile(path.join(output, 'transfer-header-diagnostic.json'), JSON.stringify({ diagnostic, jobs: jobs().map(job => ({ id: job.id, direction: job.direction, state: job.state })) }, null, 2))
      await fs.writeFile(path.join(output, 'transfer-header-failure.png'), (await win.webContents.capturePage()).toPNG())
      throw failure
    }
    const download = jobs().find(job => job.direction === 'download')!
    assert(download)
    const geometry: unknown[] = []
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      win.setSize(w!, h!)
      await new Promise(resolve => setTimeout(resolve, 200))
      const layout = await win.webContents.executeJavaScript(`(() => {
        const header = document.querySelector('[data-testid=remote-files-header]');
        const title = header.querySelector('h4');
        const activity = header.querySelector('[data-testid=remote-transfer-header]');
        const rect = node => node.getBoundingClientRect().toJSON();
        return { header: rect(header), title: rect(title), activity: rect(activity), client: header.clientWidth, scroll: header.scrollWidth };
      })()`)
      assert(layout.activity.width > 220, 'transfer content remains readable')
      assert(layout.activity.top >= layout.header.top && layout.activity.bottom <= layout.header.bottom + 1, 'activity stays in header')
      assert(layout.scroll <= layout.client + 1, 'header does not overflow horizontally')
      geometry.push({ width: w, ...layout })
      await fs.writeFile(path.join(output, `transfer-header-${w}.png`), (await win.webContents.capturePage()).toPNG())
    }
    // Pin the download using manual controls before cancelling that exact native task.
    for (let n = 0; n < 2; n++) {
      if (await win.webContents.executeJavaScript(`${status}?.getAttribute('data-transfer-id') === ${JSON.stringify(download.id)}`)) break
      await controls.clickExpression(namedButton('Next transfer'))
    }
    await controls.clickExpression("Array.from(document.querySelectorAll('[data-testid=remote-transfer-header] button')).find(button => button.textContent === window.m2Smoke.label('managedResources.files.cancelTransfer'))")
    await controls.waitFor(`${status}?.getAttribute('data-transfer-state') === 'cancelled'`, 'native cancel applies to displayed download')
    assert.equal(transfers.getJob(download.id, owner)?.state, 'cancelled')
    assert.equal(transfers.getJob(uploadId, owner)?.state, 'verifying')
    release()
    await controls.clickExpression(namedButton('Previous transfer'))
    await controls.waitFor(`${status}?.getAttribute('data-transfer-state') === 'completed'`, 'other upload completes independently', 10000)
    const actual = await transport.readFile('/workspace/transfer-header-upload/payload.bin')
    assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(await fs.readdir(destination), [])
    assert.equal(await win.webContents.executeJavaScript(`document.body.textContent.includes(${JSON.stringify(sandbox)})`), false)
    await fs.writeFile(path.join(output, 'transfer-header.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), nativeAutomaticRotation: true, uploadAndDownload: true, exactCancellation: true, checksumRetained: true, geometry, fakeSftp: true, realCredentials: false }, null, 2) + '\n')
  } finally {
    release()
    for (const job of jobs()) if (!['completed', 'failed', 'cancelled'].includes(job.state)) await transfers.cancel(job.id, owner)
    win.setSize(width, height)
  }
}
