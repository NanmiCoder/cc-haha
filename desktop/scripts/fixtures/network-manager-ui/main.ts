import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createNetworkFixture } from '../../../src/features/network-manager/testing/networkFixture'
import { ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'
import { NetworkRequestSchema } from '../../../src/features/network-manager/networkSchemas'

const sandbox = process.env.NETWORK_SMOKE_SANDBOX
const output = process.env.NETWORK_SMOKE_OUTPUT
if (!sandbox || !output) throw new Error('Isolated fixture paths are required')
app.setPath('userData', path.join(sandbox, 'electron-user-data'))
app.setName('cc-haha-network-isolated-fixture')
const fixture = createNetworkFixture()
const discovered = { pid: 102, startedAt: '2026-09-27T01:00:00Z', executablePath: 'C:\\Fixture\\SakuraCat\\com.vortex.helper.exe',
  clientExecutable: 'C:\\Fixture\\SakuraCat\\SakuraCat.exe', configPath: 'C:\\Fixture\\SakuraCat\\active.yaml',
  controller: '127.0.0.1:39798', listeningPorts: [7897, 39798], configSource: 'process-argument' as const }
Object.assign(fixture.discovery, { status: 'detected', running: true, selected: discovered, candidates: [discovered] })
fixture.snapshot.selectedRoutes = [{ target: '191.168.7.62', source: '162.168.1.2', interfaceIndex: 47,
  interfaceAlias: '124.114.142.77', prefix: '191.168.0.0/16', nextHop: '0.0.0.0' }]
fixture.snapshot.proxy.bypassPrefixes = ['191.168.0.0/16', '10.0.0.0/8']
const steps: string[] = []
let win: BrowserWindow
let stage = 'startup'
const timeout = setTimeout(() => app.exit(2), 120_000)
const hostId = '00000000-0000-4000-8000-000000000001'
ipcMain.handle(ELECTRON_IPC_CHANNELS.mrListHosts, async () => ({ ok: true, data: [{ id: hostId, name: 'Fixture server', address: 'fixture.invalid', port: 22, username: 'fixture', auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: null, applications: [], notes: '', revision: 1, createdAt: '', updatedAt: '' }] }))
ipcMain.handle(ELECTRON_IPC_CHANNELS.networkManager, async (_event, payload) => {
  const request = NetworkRequestSchema.parse(payload)
  switch (request.action) {
    case 'discoverProxy': return fixture.api.discoverProxy(request.proxyPort)
    case 'executionCatalog': return fixture.api.executionCatalog()
    case 'openNetworkConnections': return fixture.api.openNetworkConnections()
    case 'list': return fixture.api.list()
    case 'save': return fixture.api.save(request.profile, request.expectedRevision)
    case 'inspect': return fixture.api.inspect(request.profile)
    case 'plan': return fixture.api.plan(request.profile)
    case 'apply': return fixture.api.apply(request.planId)
    case 'verify': return fixture.api.verify(request.profile)
    case 'probeHost': return fixture.api.probeHost(request.hostId)
    case 'login': return fixture.api.login(request.target, request.profile)
    case 'recover': return fixture.api.recover()
    case 'vpnRouteOptions': return fixture.api.vpnRouteOptions()
    case 'vpnRoutePreview': return fixture.api.vpnRoutePreview(request.target)
    case 'vpnRouteApply': return fixture.api.vpnRouteApply(request.planId)
    case 'vpnRouteVerify': return fixture.api.vpnRouteVerify(request.target)
    case 'vpnRouteBatchPreview': return fixture.api.vpnRouteBatchPreview(request.input)
    case 'vpnRouteBatchApply': return fixture.api.vpnRouteBatchApply(request.planId)
    case 'vpnRouteBatchVerify': return fixture.api.vpnRouteBatchVerify(request.input)
    case 'vpnRouteProbe': return fixture.api.vpnRouteProbe(request.input)
  }
})

async function waitFor(expression: string) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out at ${stage}: ${expression}`)
}
function button(name: string) {
  return `Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(name)})`
}
function field(label: string) {
  return `document.getElementById(Array.from(document.querySelectorAll('label')).find(e => e.textContent.trim() === ${JSON.stringify(label)})?.htmlFor)`
}
async function click(expression: string) {
  await waitFor(`(() => {const e=${expression}; if (!e || e.disabled) return false; e.scrollIntoView({block:'center',behavior:'instant'}); const r=e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
  const point = await win.webContents.executeJavaScript(`(() => {const r=(${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function key(key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0) {
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
}
async function screenshot(name: string) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  // A hidden window can still hold the preceding compositor frame. Request a
  // capture once to refresh the surface before retaining the evidence image.
  await win.webContents.capturePage()
  await new Promise(resolve => setTimeout(resolve, 150))
  await fs.writeFile(path.join(output!, name), (await win.webContents.capturePage()).toPNG())
}

void app.whenReady().then(async () => {
  try {
    await fs.mkdir(output!, { recursive: true })
    win = new BrowserWindow({ width: 1320, height: 1080, show: false, webPreferences: { preload: path.join(sandbox!, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file:|data:|blob:)/.test(details.url) }))
    win.webContents.debugger.attach('1.3')
    await win.loadFile(path.join(sandbox!, 'ui', 'index.html'))
    stage = 'toolbar entry'
    await waitFor(`!!(${button('Network configuration')})`)
    assert.equal(await win.webContents.executeJavaScript(`(${button('Host Management')}).nextElementSibling === (${button('Network configuration')})`), true)
    await click(button('Network configuration'))
    await waitFor(`!!(${field('Profile name')})`)
    await screenshot('01-home.png')
    steps.push(stage)
    stage = 'open network connections through validated native IPC'
    assert.equal(fixture.calls.some(call => call.action === 'openNetworkConnections'), false)
    const initialName = await win.webContents.executeJavaScript(`(${field('Profile name')}).value`)
    await click(button('Open network connections'))
    await waitFor(`document.body.textContent.includes('Requested Windows Network Connections')`)
    assert.deepEqual(fixture.calls.filter(call => call.action === 'openNetworkConnections'), [{ action: 'openNetworkConnections' }])
    assert.equal(await win.webContents.executeJavaScript(`(${field('Profile name')}).value`), initialName)
    assert.equal(fixture.calls.some(call => ['save', 'apply', 'login'].includes(call.action)), false)
    await screenshot('01-network-connections.png')
    steps.push(stage)
    stage = 'running Sakura paths and read-only execution reference'
    await waitFor(`document.body.textContent.includes('Running instance identified')`)
    assert.equal(await win.webContents.executeJavaScript(`(${field('SakuraCat executable path')}).readOnly`), true)
    assert.equal(await win.webContents.executeJavaScript(`(${button('Start SakuraCat')}).disabled`), true)
    await click(button('Detect running SakuraCat'))
    await waitFor(`document.body.textContent.includes('Running instance identified') && !(${button('Detect running SakuraCat')}).disabled`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="sakura-runtime-fields"]').scrollIntoView({block:'start',behavior:'instant'})`)
    await screenshot('01-sakura-auto.png')
    await click(`document.querySelector('[data-testid="network-reference-proxy"] > summary')`)
    await waitFor(`document.body.textContent.includes('Get-SakuraProcesses')`)
    await click(`Array.from(document.querySelectorAll('[data-testid="network-reference-proxy"] details summary')).find(e => e.textContent.includes('proxyDiscover'))`)
    await screenshot('01-execution-reference.png')
    assert.equal(fixture.calls.some(call => ['apply','login','save'].includes(call.action)), false)
    await click(`document.querySelector('[data-testid="network-reference-proxy"] > summary')`)
    steps.push(stage)
    stage = 'batch VPN routes and endpoint probe through native IPC'
    await waitFor(`!!(${field('Destination IPs or CIDR ranges')}) && !!(${field('Windows VPN')})`)
    await click(field('Destination IPs or CIDR ranges'))
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '10.0.0.199\n10.55.1.7' })
    await click(button('Refresh measured paths'))
    await waitFor(`document.body.textContent.includes('Current measured paths') && document.body.textContent.includes('162.168.1.2') && document.body.textContent.includes('10.0.0.199') && document.body.textContent.includes('192.168.3.93') && document.body.textContent.includes('WLAN') && document.body.textContent.includes('DIRECT')`)
    await screenshot('01-measured-paths.png')
    await click(button('Preview VPN route'))
    await waitFor(`document.body.textContent.includes('2 destinations') && !(${button('Apply reviewed route')}).disabled`)
    await screenshot('01-vpn-route-preview.png')
    await click(button('Apply reviewed route'))
    await waitFor(`document.body.textContent.includes('VPN route applied; verify connectivity separately') && document.body.textContent.includes('Endpoint responded')`)
    assert.equal(fixture.calls.find(call => call.action === 'vpnRouteBatchApply')?.input, '22222222-2222-4222-8222-222222222222')
    assert.deepEqual((fixture.calls.find(call => call.action === 'vpnRouteBatchPreview')?.input as { destinations: string[] }).destinations, ['10.0.0.199', '10.55.1.7'])
    assert.equal((fixture.calls.find(call => call.action === 'vpnRouteProbe')?.input as { address: string; port: number; protocol: string }).address, '10.0.0.199')
    await click(button('Check actual route'))
    await waitFor(`document.body.textContent.includes('Already bound')`)
    assert.equal(fixture.calls.filter(call => call.action === 'vpnRouteBatchVerify').length, 2)
    await screenshot('01-vpn-route-applied.png')
    steps.push(stage)
    stage = 'work mode remains read only'
    await click(button('Work network'))
    await waitFor(`!(${button('Open Windows VPN sign-in')})`)
    assert.equal(fixture.calls.some(call => ['apply', 'login'].includes(call.action)), false)
    await screenshot('02-work.png')
    steps.push(stage)
    stage = 'edit and save through native IPC'
    await click(field('Profile name'))
    await key('a', 'KeyA', 65, 2)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Office fixture' })
    await click(button('Save profile'))
    await waitFor(`document.body.textContent.includes('Profile saved; not applied.')`)
    assert.equal(fixture.calls.filter(call => call.action === 'save').length, 1)
    steps.push(stage)
    stage = 'preview and apply native IPC'
    await click(button('Inspect and preview changes'))
    await waitFor(`!(${button('Apply this plan')}).disabled`)
    await screenshot('03-plan.png')
    await click(button('Apply this plan'))
    await waitFor(`document.body.textContent.includes('Changes executed. Verify the target host next.')`)
    assert.equal(fixture.calls.find(call => call.action === 'apply')?.input, 'fixture-plan')
    steps.push(stage)
    stage = 'managed-host TCP probe'
    await click(field('Choose a managed host'))
    await key('ArrowDown', 'ArrowDown', 40)
    await key('Enter', 'Enter', 13)
    await waitFor(`(${field('Choose a managed host')}).value === ${JSON.stringify(hostId)}`)
    await click(button('Test host TCP port'))
    await waitFor(`document.body.textContent.includes('Fixture TCP connected')`)
    assert.equal(fixture.calls.find(call => call.action === 'probeHost')?.input, hostId)
    await win.webContents.executeJavaScript(`(${button('Test host TCP port')}).scrollIntoView({block:'end',behavior:'instant'})`)
    await screenshot('04-probe.png')
    steps.push(stage)
    stage = 'themes'
    for (const theme of ['white', 'light', 'dark']) {
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await screenshot(`05-${theme}.png`)
    }
    steps.push(stage)
    stage = 'Chinese locale'
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'white'; window.setNetworkFixtureLocale('zh')")
    await waitFor(`!!(${button('验证主机 TCP 端口')})`)
    await win.webContents.executeJavaScript(`(${button('验证主机 TCP 端口')}).scrollIntoView({block:'end',behavior:'instant'})`)
    await screenshot('06-probe-zh.png')
    await click(button('关闭网络配置'))
    await click(button('网络配置'))
    await waitFor(`!!(${field('模式名称')}) && !(${field('模式名称')}).disabled`)
    await click(button('复制为新模式'))
    await click(field('模式名称'))
    await key('a', 'KeyA', 65, 2)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '家庭网络' })
    await click(button('家庭网络'))
    await waitFor(`!!(${button('打开 Windows VPN 登录')})`)
    await click(button('保存模式'))
    await waitFor(`document.body.textContent.includes('模式已保存，尚未应用。')`)
    await win.webContents.executeJavaScript(`(${field('模式名称')}).scrollIntoView({block:'center',behavior:'instant'})`)
    await screenshot('06-home-zh.png')
    await waitFor(`document.body.textContent.includes('已识别运行实例')`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="sakura-runtime-fields"]').scrollIntoView({block:'start',behavior:'instant'})`)
    await screenshot('07-sakura-auto-zh.png')
    await click(`document.querySelector('[data-testid="network-reference-proxy"] > summary')`)
    await waitFor(`document.querySelector('[data-testid="network-reference-proxy"]').textContent.includes('proxyDiscover')`)
    await screenshot('08-reference-zh.png')
    steps.push(stage)
    await click(button('打开网络连接'))
    await waitFor(`document.body.textContent.includes('已请求打开 Windows 网络连接')`)
    assert.equal(fixture.calls.filter(call => call.action === 'openNetworkConnections').length, 2)
    await screenshot('09-network-connections-zh.png')
    await fs.writeFile(path.join(output!, 'result.json'), JSON.stringify({ status: 'passed', steps, evidence: 'Native Electron renderer, real preload IPC validation and mocked network provider; no live network operations.' }, null, 2))
    console.log(JSON.stringify({ status: 'passed', steps, output }))
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    if (win) await screenshot('failure.png').catch(() => undefined)
    await fs.writeFile(path.join(output!, 'result.json'), JSON.stringify({ status: 'failed', stage, steps, error: String(error) }, null, 2))
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
})
