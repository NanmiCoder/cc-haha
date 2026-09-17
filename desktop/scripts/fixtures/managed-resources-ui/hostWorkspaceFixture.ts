import { verifyHostTools, HOST_TOOLS_FIXTURE_COMMAND, HOST_TOOLS_JAVA_FRAME } from './hostToolsFixture'
import { JAVA_PROCESS_COMMAND } from '../../../electron/services/managedResources/javaProcessProtocol'
import { verifyApplicationLayout } from './applicationLayoutFixture'
import { verifyRemoteFolders } from './remoteFoldersFixture'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { Server as SshServer, type Connection } from 'ssh2'
import type { ManagedResourcesModule } from '../../../electron/services/managedResources/index'
import { createFakeSftpTransport } from '../../../electron/services/managedResources/sftpTestTransport'
import { createSftpService, createRemoteEditService, createTransferService } from '../../../electron/services/managedResources/sftpService'
import { seedRemoteEditors, verifyRemoteEditors } from './remoteEditorsFixture'

type Controls = {
  clickButton: (key: string, selector?: string, scope?: string) => Promise<void>
  clickExpression: (expression: string) => Promise<void>
  waitFor: (expression: string, label: string, timeout?: number) => Promise<void>
  type: (selector: string, value: string) => Promise<void>
}

// Extend the existing offline native smoke: real xterm/IPC/SSH transport, and
// only the SFTP driver replaced by a filesystem inside an isolated temp dir.
export async function createHostWorkspaceFixture(module: ManagedResourcesModule, sandbox: string, password: string, directorySelections: string[] = []) {
  const peers = new Set<Connection>()
  const input: Buffer[] = []
  const scriptCommands: string[] = []
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
  const server = new SshServer({ hostKeys: [key] }, client => {
    peers.add(client)
    client.on('error', () => {})
    client.on('close', () => peers.delete(client))
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === password) context.accept()
      else context.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', acceptPty => acceptPty())
      session.on('window-change', acceptResize => acceptResize?.())
      session.on('exec', (acceptExec, rejectExec, info) => {
        // Exact fixture allowlist. Never execute a command on the developer's OS.
        if (info.command !== JAVA_PROCESS_COMMAND && info.command !== HOST_TOOLS_FIXTURE_COMMAND) { rejectExec(); return }
        const stream = acceptExec()
        stream.on('error', () => {})
        stream.resume()
        if (info.command === JAVA_PROCESS_COMMAND) stream.write(HOST_TOOLS_JAVA_FRAME)
        else { scriptCommands.push(info.command); stream.write('HOST_TOOLS_FIXTURE_OUTPUT\n') }
        stream.exit(0)
        stream.end()
      })
      session.on('shell', acceptShell => {
        const stream = acceptShell()
        stream.write('fixture$ ')
        stream.on('data', (bytes: Buffer) => {
          input.push(Buffer.from(bytes))
          stream.write(bytes.toString('utf8').replaceAll('\r', '\r\n'))
        })
      })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as { port: number }).port
  const transport = await createFakeSftpTransport()
  for (let i = 0; i < 35; i++) await transport.seedFile(`/workspace/dir-${String(i).padStart(2, '0')}/keep.txt`, 'fixture')
  const original = Array.from({ length: 120 }, (_, i) => `Fixture line ${i + 1}: remote file editor`).join('\n') + '\n'
  await transport.seedFile('/workspace/README.txt', original)
  await seedRemoteEditors(transport)
  const resolveSession = (request: { connectionId: string; ownerId: string }) => {
    const actual = module.services.sshService.getInternalsForOwner(request.connectionId, request.ownerId)
    if (!actual || actual.session.status !== 'ready') throw new Error('DISCONNECTED')
    transport.setGeneration(actual.generation)
    return { ...actual, client: transport.resolveSession(request).client }
  }
  const sftpService = createSftpService({ resolveSession, tempDir: sandbox })
  const transferService = createTransferService({ resolveSession, sftpService, localPathService: module.services.localPathService })
  const remoteEditService = createRemoteEditService({ resolveSession, sftpService, localPathService: module.services.localPathService })
  module.services.sftpService.dispose()
  module.services.transferService.dispose()
  module.services.sftpService = sftpService
  module.services.transferService = transferService
  module.services.remoteEditService = remoteEditService

  return {
    port,
    async verify(win: BrowserWindow, controls: Controls, output: string) {
      const { clickButton, clickExpression, waitFor, type } = controls
      await clickExpression('document.querySelector("[data-testid=host-terminal-tab]")')
      await clickButton('managedResources.ssh.connect')
      await clickButton('managedResources.ssh.trustAndContinue')
      await waitFor('Boolean(document.querySelector("[data-status=ready]"))', 'SSH PTY ready')
      const terminalText = 'document.querySelector(".xterm-rows")?.textContent'
      await waitFor(`${terminalText}?.includes('fixture$ ')`, 'single prompt')
      assert.equal(await win.webContents.executeJavaScript(`(${terminalText} || '').split('fixture$ ').length - 1`), 1)
      const driver = win.webContents.debugger
      await win.webContents.executeJavaScript('document.querySelector(".xterm-helper-textarea").focus()')
      for (let count = 1; count <= 2; count++) {
        await driver.sendCommand('Input.insertText', { text: 'll' })
        await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await waitFor(`(${terminalText} || '').split('ll').length - 1 === ${count}`, 'one visible echo per command')
        assert.equal(Buffer.concat(input).toString('utf8'), 'll\r'.repeat(count))
      }
      await fs.writeFile(path.join(output, 'ssh-terminal-once.png'), (await win.webContents.capturePage()).toPNG())
      await clickExpression('document.querySelector("[data-testid=host-files-tab]")')
      await waitFor('Boolean(document.querySelector("[data-testid=remote-file-browser] [role=list]"))', 'file listing')
      await clickExpression('Array.from(document.querySelectorAll("[data-testid=remote-file-browser] button")).find(button => button.textContent.includes("README.txt"))')
      await waitFor('Boolean(document.querySelector("[data-testid=remote-file-editor] textarea"))', 'remote edit open')
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const left=document.querySelector('[data-testid=remote-file-browser]');
        const right=document.querySelector('[data-testid=remote-file-editor]');
        const list=left.querySelector('[role=list]'); const editor=right.querySelector('textarea');
        const a=left.getBoundingClientRect(); const b=right.getBoundingClientRect(); const c=list.getBoundingClientRect(); const d=editor.getBoundingClientRect();
        return {display:getComputedStyle(left.parentElement).display,columns:getComputedStyle(left.parentElement).gridTemplateColumns,left:a.toJSON(),right:b.toJSON(),list:c.toJSON(),editor:d.toJSON(),listOverflow:getComputedStyle(list).overflowY,listScroll:list.scrollHeight>list.clientHeight,editorScroll:editor.scrollHeight>editor.clientHeight,spellcheck:editor.spellcheck};
      })()`)
      await fs.writeFile(path.join(output, 'layout-observed.json'), JSON.stringify(geometry, null, 2) + '\n')
      await fs.writeFile(path.join(output, 'layout-observed.png'), (await win.webContents.capturePage()).toPNG())
      assert.ok(geometry.left.right <= geometry.right.left, 'panes are side-by-side')
      assert.ok(Math.abs(geometry.left.top - geometry.right.top) < 2, 'panes share a top edge')
      assert.ok(geometry.list.bottom <= geometry.left.bottom && geometry.editor.bottom <= geometry.right.bottom, 'both contents are bounded')
      assert.equal(geometry.listOverflow, 'auto')
      assert.equal(geometry.listScroll, true)
      assert.equal(geometry.editorScroll, true)
      assert.equal(geometry.spellcheck, false)
      const draft = 'Edited through native keyboard\n' + original
      await type('[data-testid=remote-file-editor] textarea', draft)
      await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
      await waitFor('Boolean(document.querySelector("[data-testid=host-applications-panel]"))', 'applications tab')
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=remote-files-split]").getBoundingClientRect().height'), 0)
      await clickExpression('document.querySelector("[data-testid=host-files-tab]")')
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=remote-file-editor] textarea").value'), draft)
      await clickButton('managedResources.files.save')
      await waitFor('Array.from(document.querySelectorAll("[data-testid=remote-file-editor] button")).some(button => button.disabled)', 'file saved')
      assert.equal((await transport.readFile('/workspace/README.txt')).toString('utf8'), draft)
      await fs.writeFile(path.join(output, 'remote-files-split.png'), (await win.webContents.capturePage()).toPNG())
      await fs.writeFile(path.join(output, 'workspace-layout.json'), JSON.stringify({ geometry, inputVerifiedOnce: true, repeatedCommands: 2, draftSurvivedTabSwitch: true, savedThroughIpc: true }, null, 2) + '\n')
      await verifyRemoteEditors(win, controls, transport, output)
      await verifyRemoteFolders(win, controls, transport, sandbox, output, directorySelections)
      await verifyApplicationLayout(win, controls, transport, output)
      await verifyHostTools(win, controls, transport, scriptCommands, output)
      await clickExpression('document.querySelector("[data-testid=host-terminal-tab]")')
      await waitFor('document.querySelector("[data-testid=host-terminal-tab]").getAttribute("aria-selected") === "true"', 'terminal tab selected before disconnect')
      await waitFor(`(${terminalText} || '').split('ll').length - 1 === 2`, 'terminal buffer restored after tab switch')
      await clickButton('managedResources.ssh.disconnect')
      try {
        await waitFor('Boolean(document.querySelector("[data-status=closed]"))', 'SSH disconnect')
      } catch (error) {
        const diagnostic = await win.webContents.executeJavaScript(`({
          status: Array.from(document.querySelectorAll('[data-status]')).map(element => element.getAttribute('data-status')),
          selected: Array.from(document.querySelectorAll('[role=tab][aria-selected=true]')).map(element => element.getAttribute('data-testid')),
          alerts: Array.from(document.querySelectorAll('[role=alert]')).map(element => element.textContent),
          buttons: Array.from(document.querySelectorAll('[data-host-id] button')).map(element => ({label:element.getAttribute('aria-label'),box:element.getBoundingClientRect().toJSON()}))
        })`)
        await fs.writeFile(path.join(output, 'disconnect-diagnostic.json'), JSON.stringify(diagnostic, null, 2))
        throw error
      }
    },
    async close() {
      sftpService.dispose()
      transferService.dispose()
      await module.services.sshService.dispose()
      for (const peer of peers) peer.end()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await transport.dispose()
    },
  }
}
