import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { FakeSftpTransport } from '../../../electron/services/managedResources/sftpTestTransport'

type Controls = {
  clickExpression: (expression: string) => Promise<void>
  waitFor: (expression: string, label: string, timeout?: number) => Promise<void>
}

/** Native DOM -> preload -> main folder picker grant -> streaming service, offline. */
export async function verifyRemoteFolders(win: BrowserWindow, controls: Controls, transport: FakeSftpTransport, sandbox: string, output: string, selections: string[]) {
  const { clickExpression, waitFor } = controls
  const source = path.join(sandbox, 'native-folder')
  const destination = path.join(sandbox, 'downloaded-folders')
  await fs.mkdir(path.join(source, '中文目录', 'empty-dir'), { recursive: true })
  await fs.mkdir(destination)
  await fs.writeFile(path.join(source, '.bashrc'), 'export LANG=C.UTF-8\n')
  await fs.writeFile(path.join(source, '中文目录', 'empty.txt'), '')
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 90)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(path.join(source, '中文目录', 'large.bin'), bytes)
  const completed = "!document.querySelector('[data-testid=remote-upload-folder]')?.disabled && Array.from(document.querySelectorAll('[role=status]')).some(element => element.textContent.includes(window.m2Smoke.label('managedResources.files.transferCompleted')))"
  selections.push(source)
  await clickExpression("document.querySelector('[data-testid=remote-upload-folder]')")
  await waitFor(completed, 'native recursive upload completes', 20000)
  assert.equal((await transport.readFile('/workspace/native-folder/.bashrc')).toString('utf8'), 'export LANG=C.UTF-8\n')
  assert.equal(createHash('sha256').update(await transport.readFile('/workspace/native-folder/中文目录/large.bin')).digest('hex'), checksum)
  selections.push(destination)
  await clickExpression("Array.from(document.querySelectorAll('[data-testid=remote-file-browser] button')).find(element => element.getAttribute('aria-label') === window.m2Smoke.label('managedResources.transfer.downloadFolder') + ': native-folder')")
  await waitFor(completed, 'native recursive download completes', 20000)
  const downloaded = path.join(destination, 'native-folder')
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(downloaded, '中文目录', 'large.bin'))).digest('hex'), checksum)
  assert.equal(await fs.readFile(path.join(downloaded, '.bashrc'), 'utf8'), 'export LANG=C.UTF-8\n')
  assert.equal((await fs.stat(path.join(downloaded, '中文目录', 'empty.txt'))).size, 0)
  assert.equal((await fs.stat(path.join(downloaded, '中文目录', 'empty-dir'))).isDirectory(), true)
  assert.deepEqual(await fs.readdir(destination), ['native-folder'])
  assert.equal(await win.webContents.executeJavaScript(`document.body.textContent.includes(${JSON.stringify(sandbox)})`), false)
  assert.equal(selections.length, 0)
  await fs.writeFile(path.join(output, 'folder-transfers.png'), (await win.webContents.capturePage()).toPNG())
  await fs.writeFile(path.join(output, 'folder-transfers.json'), JSON.stringify({ status: 'passed', testedAt: new Date().toISOString(), uploadViaNativeDom: true, downloadViaNativeDom: true, bytes: bytes.length, checksum, hierarchy: true, hiddenFiles: true, emptyFiles: true, emptyDirectories: true, rendererDoesNotShowNativePath: true, fakeSftp: true, realCredentials: false }, null, 2) + '\n')
}
