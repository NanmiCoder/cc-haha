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
export async function seedRemoteEditors(transport: FakeSftpTransport) {
  await transport.seedFile('/workspace/.bashrc', 'export LANG=C.UTF-8\n')
  await transport.seedFile('/workspace/formatted.md', '# Native title\n\nA **bold** value.\n\n| Key | Value |\n|---|---|\n| a | b |\n\n```bash\necho hi\n```\n')
  await transport.seedFile('/workspace/editable.md', '')
}
export async function verifyRemoteEditors(win: BrowserWindow, controls: Controls, transport: FakeSftpTransport, output: string) {
  const { clickButton, clickExpression, waitFor, type } = controls
  const open = async (name: string) => {
    await clickExpression(`Array.from(document.querySelectorAll('[data-testid=remote-file-browser] button')).find(button => button.textContent.includes(${JSON.stringify(name)}))`)
    await waitFor(`document.querySelector('[data-testid=remote-file-editor] [title]')?.getAttribute('title') === ${JSON.stringify('/workspace/' + name)}`, 'selected remote editor')
  }
  await open('.bashrc')
  await waitFor("Boolean(document.querySelector('[data-editor-language=bash] [data-highlight-engine=shiki]'))", 'Bash tokens')
  const shell = 'export LANG=C.UTF-8\n# Native edited 中文\n'
  await type('[data-testid=remote-file-editor] textarea', shell)
  await clickButton('managedResources.files.save')
  await waitFor("Array.from(document.querySelectorAll('[data-testid=remote-file-editor] button')).some(button => button.disabled)", 'Bash save completes')
  assert.equal((await transport.readFile('/workspace/.bashrc')).toString('utf8'), shell)
  await fs.writeFile(path.join(output, 'bash-editor.png'), (await win.webContents.capturePage()).toPNG())

  await open('formatted.md')
  await waitFor("Boolean(document.querySelector('[data-testid=remote-file-editor] .ProseMirror table'))", 'formatted Markdown table')
  const rendered = await win.webContents.executeJavaScript(`(() => {
    const root=document.querySelector('[data-testid=remote-file-editor] .ProseMirror');
    return {heading:root.querySelector('h1')?.textContent,bold:root.querySelector('strong')?.textContent,cell:root.querySelector('td')?.textContent,editable:root.getAttribute('contenteditable'),images:root.querySelectorAll('img,iframe,script').length};
  })()`)
  assert.deepEqual(rendered, { heading: 'Native title', bold: 'bold', cell: 'a', editable: 'true', images: 0 })
  await fs.writeFile(path.join(output, 'markdown-formatted.png'), (await win.webContents.capturePage()).toPNG())
  await open('editable.md')
  await type('[data-testid=remote-file-editor] .ProseMirror', 'Native Markdown 中文')
  const driver = win.webContents.debugger
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await clickButton('managedResources.files.editor.bold')
  await clickExpression("Array.from(document.querySelectorAll('[data-testid=remote-file-editor] button')).find(button => button.getAttribute('aria-label') === window.m2Smoke.label('managedResources.files.editor.heading',{level:2}))")
  await waitFor("document.querySelector('[data-testid=remote-file-editor] .ProseMirror h2 strong')?.textContent === 'Native Markdown 中文'", 'rich edit applies heading and bold')
  await clickButton('managedResources.files.editor.source', '[role=tab]')
  await waitFor("document.querySelector('[data-testid=remote-file-editor] textarea')?.value === '## **Native Markdown 中文**'", 'source reflects formatted edit')
  await clickButton('managedResources.files.save')
  await waitFor("Array.from(document.querySelectorAll('[data-testid=remote-file-editor] button')).some(button => button.disabled)", 'Markdown save completes')
  assert.equal((await transport.readFile('/workspace/editable.md')).toString('utf8'), '## **Native Markdown 中文**')
  await clickButton('managedResources.files.editor.formatted', '[role=tab]')
  await waitFor("document.querySelector('[data-testid=remote-file-editor] h2 strong')?.textContent === 'Native Markdown 中文'", 'saved formatted edit restored')
  await fs.writeFile(path.join(output, 'markdown-edited.png'), (await win.webContents.capturePage()).toPNG())
  await fs.writeFile(path.join(output, 'remote-editors.json'), JSON.stringify({ status: 'passed', bashHighlight: true, shellSavedViaIpc: true, markdownRendered: rendered, markdownEditedViaNativeInput: true, sourceModeSynchronized: true, markdownSavedViaIpc: true, testedAt: new Date().toISOString(), fakeSftp: true }, null, 2) + '\n')
}
