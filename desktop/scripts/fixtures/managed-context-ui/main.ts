import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createManagedResourcesModule } from '../../../electron/services/managedResources'
import { createContextTicketClient } from '../../../electron/services/managedResources/contextTicketClient'
import { ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'

const sandbox = process.env.CONTEXT_UI_SANDBOX!
const output = process.env.CONTEXT_UI_OUTPUT!
const serverUrl = process.env.CONTEXT_UI_SERVER!
const token = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN!
if (!sandbox || !output || !/^http:\/\/127\.0\.0\.1:\d+$/.test(serverUrl) || !token) throw new Error('Missing isolated fixture configuration')
const SECRET = 'fake-host-password-native-123'
app.setPath('userData', path.join(sandbox, 'electron-profile'))
app.setName('cc-haha-context-native-fixture')
let win: BrowserWindow | undefined
let module: ReturnType<typeof createManagedResourcesModule> | undefined
let stage = 'boot'
let decrypts = 0
const steps: string[] = []
const deadline = setTimeout(() => app.exit(2), 140_000)

async function wait(expression: string, label: string, timeout = 20_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await win!.webContents.executeJavaScript(expression)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`Native context wait failed: ${label}`)
}
async function click(expression: string) {
  await wait(`Boolean(${expression})`, 'click target')
  const point = await win!.webContents.executeJavaScript(`(() => { const e=${expression}; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
const select = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`
const byId = (id: string) => select(`[data-testid="${id}"]`)
async function button(key: string) {
  const expression = `Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === window.contextSmoke.label(${JSON.stringify(key)}))`
  await wait(`Boolean(${expression}) && !(${expression}).disabled`, 'enabled ' + key)
  await click(expression)
}
async function type(selector: string, value: string) {
  await click(select(selector))
  const driver = win!.webContents.debugger
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await driver.sendCommand('Input.insertText', { text: value })
}
async function sdkInputs(): Promise<Array<{ messages: Array<{ role: string; content: string }> }>> {
  return JSON.parse(await fs.readFile(path.join(sandbox, 'sdk-inputs.json'), 'utf8').catch(() => '[]'))
}
async function completed(count: number) {
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    if ((await sdkInputs()).length >= count && await win!.webContents.executeJavaScript(`document.querySelector('[data-testid=fixture-state]')?.textContent.includes('idle')`)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('SDK did not complete the expected native UI turn')
}
async function publicState() {
  const value = await win!.webContents.executeJavaScript('window.contextSmoke.snapshot()')
  assert.equal(JSON.stringify(value).includes(SECRET), false, 'renderer public state must not contain the injected password')
  return value
}

void app.whenReady().then(async () => {
  try {
    await fs.mkdir(output, { recursive: true })
    win = new BrowserWindow({ width: 1280, height: 980, show: false, webPreferences: { preload: path.join(sandbox, 'context-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      callback({ cancel: !['file:', 'data:', 'blob:'].includes(url.protocol) && !((url.protocol === 'http:' || url.protocol === 'ws:') && url.host === new URL(serverUrl).host) })
    })
    ipcMain.handle(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl, () => serverUrl)
    ipcMain.handle(ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken, () => token)
    ipcMain.handle('context-fixture-work-dir', event => {
      if (event.sender !== win!.webContents || event.senderFrame !== win!.webContents.mainFrame) throw new Error('Untrusted fixture caller')
      return path.join(sandbox, 'work')
    })
    module = createManagedResourcesModule({
      ipcMain, getMainWindow: () => win ?? null, activeConfigDir: path.join(sandbox, 'resources-config'), userDataDir: sandbox,
      contextTicketClient: createContextTicketClient({ getServerUrl: async () => serverUrl, getLocalAccessToken: () => token }),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('fixture:' + value), decryptString: value => { decrypts += 1; return value.toString('utf8').slice('fixture:'.length) } },
    })
    await win.loadFile(path.join(sandbox, 'ui', 'index.html'))
    win.webContents.debugger.attach('1.3')
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message.replaceAll(SECRET, '[fixture-secret]').slice(0, 1200)) })
    await wait('Boolean(window.contextSmoke)', 'bootstrap')
    stage = 'DOM creates host and encrypted fixture credential'
    await button('common.add')
    await type('#host-name-input', 'Native context host')
    await type('#host-address-input', 'fixture.invalid')
    await type('#host-password-input', SECRET)
    await click("document.querySelector('button[type=submit]')")
    await wait('!document.querySelector("[role=dialog]")', 'host saved')
    const doc = await module.services.store.load()
    if (doc.status !== 'ready') throw new Error('No resource document')
    const host = doc.document.hosts[0]!
    assert.equal(doc.document.credentials.length, 1)
    steps.push(stage)

    stage = 'real session action and WebSocket connected'
    await click(byId('fixture-create-chat'))
    await wait(`document.querySelector('[data-testid=fixture-state]')?.textContent.includes('connected')`, 'real WebSocket')
    await wait('Boolean(document.querySelector("[contenteditable=true]"))', 'composer')
    steps.push(stage)

    stage = 'no-password DOM selection -> main prepare -> staging -> WS -> SDK'
    await click(byId('context-entry-host'))
    await click(byId(`context-option-resource-${host.id}`))
    await button('managedResources.context.close')
    const before = decrypts
    await type('[contenteditable=true]', 'NATIVE_CONTEXT_FIRST')
    await button('common.run')
    await completed(1)
    assert.equal(decrypts, before, 'no-password preparation must not decrypt')
    const first = (await sdkInputs())[0]!.messages.at(-1)!.content
    assert.equal(first.includes(SECRET), false)
    assert.equal(first.includes(host.address), true)
    assert.equal(first.split('<cc-haha:managed-context>').length, 2)
    await publicState()
    steps.push(stage)

    stage = 'password checkbox -> vault -> SDK without renderer/manifest/history/trace copies'
    await click(byId('context-entry-host'))
    await click(byId('context-include-passwords'))
    await button('managedResources.context.close')
    await type('[contenteditable=true]', 'NATIVE_CONTEXT_SECOND')
    await button('common.run')
    await completed(2)
    const second = (await sdkInputs())[1]!.messages.at(-1)!.content
    assert.equal(second.includes(SECRET), true, 'real vault output must reach the SDK')
    assert.equal(second.split('<cc-haha:managed-context>').length, 2)
    const state = await publicState()
    for (const route of [`/api/sessions/${state.sessionId}/messages`, `/api/sessions/${state.sessionId}`, `/api/sessions/${state.sessionId}/trace`, '/api/sessions?limit=100']) {
      const response = await fetch(serverUrl + route, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.ok, true)
      assert.equal((await response.text()).includes(SECRET), false, `public route ${route}`)
    }
    await fs.writeFile(path.join(output, 'native-context.png'), (await win.webContents.capturePage()).toPNG())
    steps.push(stage)
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', steps, platform: process.platform, electron: process.versions.electron, testedAt: new Date().toISOString(), sdkInputCount: (await sdkInputs()).length, realProvider: false, fakeVault: true, realDesktopHostIpc: true, realLoopbackServer: true, realConversationService: true, mockSdkCli: true, privateFixtureInputsDeletedAfterRun: true }, null, 2) + '\n')
    console.log('PASS native context full UI-to-SDK join')
    module.cleanup()
    win.destroy()
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    // Never print the input, password or serialized renderer state on failure.
    const diagnostics = win && !win.isDestroyed() ? await win.webContents.executeJavaScript(`(() => { const state=window.contextSmoke?.snapshot(); const chat=state?.chat?.[state.sessionId]; return { connection:chat?.connectionState, turn:chat?.chatState, editorLength:document.querySelector('[contenteditable=true]')?.textContent?.length, errors:chat?.messages?.filter(m=>m.type==='error').map(m=>({type:m.type,code:m.code,message:m.message??m.text})), selected:state?.selection?.resolved, buttons:Array.from(document.querySelectorAll('button')).filter(b=>b.getAttribute('aria-label')==='Run').map(b=>({disabled:b.disabled})) } })()`).catch(() => null) : null
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', stage, diagnostics, message: String(error instanceof Error ? error.message : error).replaceAll(SECRET, '[fixture-secret]'), testedAt: new Date().toISOString() }, null, 2) + '\n')
    console.error('FAIL native context join at ' + stage)
    module?.cleanup()
    win?.destroy()
    clearTimeout(deadline)
    app.exit(1)
  }
})
