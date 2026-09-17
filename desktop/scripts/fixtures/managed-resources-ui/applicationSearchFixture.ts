import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { FakeSftpTransport } from '../../../electron/services/managedResources/sftpTestTransport'

type Controls = {
  clickButton: (key: string, selector?: string, scope?: string) => Promise<void>
  clickExpression: (expression: string) => Promise<void>
  waitFor: (expression: string, label: string, timeout?: number) => Promise<void>
  type: (selector: string, value: string) => Promise<void>
}

/** Native keyboard and mouse on production components; only remote files are fixtures. */
export async function verifyApplicationSearch(win: BrowserWindow, controls: Controls, remote: FakeSftpTransport, root: string, output: string) {
  const { clickButton, clickExpression, waitFor, type } = controls
  const directories = [['apps', 'jar'], ['conf', 'conf'], ['logs', 'log'], ['bin/bin', 'sh']] as const
  const panel = (directory: string) => `document.querySelector('[data-app-directory="${directory}"]')`
  const inputSelector = (directory: string) => `[data-app-directory="${directory}"] input[type="search"]`
  const firstRow = (directory: string) => `${panel(directory)}.querySelector('[data-application-entry]')`
  const button = (directory: string, key: string, suffix: string) => `Array.from(${panel(directory)}.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === window.m2Smoke.label('managedResources.appOperations.${key}') + ': ' + ${JSON.stringify(suffix)})`
  const completed: string[] = []
  for (const [directory, extension] of directories) {
    const toggle = `${panel(directory)}.querySelector('button[aria-expanded]')`
    if (await win.webContents.executeJavaScript(`${toggle}.getAttribute('aria-expanded') === 'false'`)) await clickExpression(toggle)
    const parent = `Array.from(${panel(directory)}.querySelectorAll('button')).find(button => button.textContent.trim() === '../')`
    if (await win.webContents.executeJavaScript(`Boolean(${parent})`)) await clickExpression(parent)
    const filename = `z-服务-REPORT.${extension}`
    await remote.seedFile(`${root}/${directory}/${filename}`, 'native search fixture\n')
    await waitFor(`!${button(directory, 'refresh', directory)}.disabled`, 'directory refresh ready')
    await clickExpression(button(directory, 'refresh', directory))
    await waitFor(`${panel(directory)}.querySelector('[data-application-entry="${filename}"]') !== null`, 'new fixture listed')
    await type(inputSelector(directory), '服务-report')
    await waitFor(`${panel(directory)}.querySelectorAll('[data-application-entry]').length === 1`, 'filename search filters current directory')
    assert.equal(await win.webContents.executeJavaScript(`${firstRow(directory)}.dataset.applicationEntry`), filename)
    await clickExpression(button(directory, 'pin', filename))
    await waitFor(`${firstRow(directory)}.dataset.pinned === 'true'`, 'file pinned')
    await clickExpression(button(directory, 'clearSearch', directory))
    await waitFor(`${panel(directory)}.querySelectorAll('[data-application-entry]').length > 1`, 'clear restores remaining files')
    assert.equal(await win.webContents.executeJavaScript(`${firstRow(directory)}.dataset.applicationEntry`), filename)
    completed.push(directory)
  }
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid=application-file-lists-scroll]').scrollIntoView({block:'center'})`)
  await fs.writeFile(path.join(output, 'application-search-pinned.png'), (await win.webContents.capturePage()).toPNG())
  // Destroy and recreate the production workspace: restored order must come from IPC/disk.
  await clickExpression('document.querySelector("[data-testid=host-terminal-tab]")')
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  for (const [directory, extension] of directories) {
    await waitFor(`${firstRow(directory)}?.dataset.pinned === 'true' && ${firstRow(directory)}.dataset.applicationEntry === 'z-服务-REPORT.${extension}'`, 'pins restored after workspace reopen')
  }
  await type(inputSelector('logs'), '服务')
  await clickExpression(`${panel('logs')}.querySelector('button[aria-expanded]')`)
  await clickButton('managedResources.appOperations.fullScreen')
  await clickExpression(`${panel('logs')}.querySelector('button[aria-expanded]')`)
  await waitFor(`document.querySelector(${JSON.stringify(inputSelector('logs'))}).value === '服务'`, 'query survives collapse and fullscreen')
  await waitFor(`${firstRow('logs')}.dataset.pinned === 'true'`, 'pin survives fullscreen')
  await fs.writeFile(path.join(output, 'application-search-fullscreen.png'), (await win.webContents.capturePage()).toPNG())
  await clickExpression(`document.querySelector(${JSON.stringify(inputSelector('logs'))})`)
  const escape = async () => {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await escape()
  await waitFor(`document.querySelector(${JSON.stringify(inputSelector('logs'))}).value === ''`, 'first Escape clears search')
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid=application-workspace]').dataset.fullscreen`), 'true')
  await escape()
  await waitFor(`document.querySelector('[data-testid=application-workspace]').dataset.fullscreen === 'false'`, 'second Escape restores workspace')
  for (const [directory, extension] of directories) {
    const filename = `z-服务-REPORT.${extension}`
    await clickExpression(button(directory, 'unpin', filename))
    await waitFor(`${firstRow(directory)}.dataset.applicationEntry !== '${filename}'`, 'unpin restores original order')
    await waitFor(`!${button(directory, 'pin', filename)}.disabled`, 'unpin committed')
  }
  await fs.writeFile(path.join(output, 'application-search.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), directories: completed, chineseSearch: true, pinAndUnpin: true, clearingKeepsPins: true, restoredAfterReopen: true, fullscreenAndCollapsePreserved: true, escapePriority: true, fakeSftp: true, realCredentials: false }, null, 2) + '\n')
}
