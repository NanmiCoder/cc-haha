import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createManagedResourcesModule } from '../../../electron/services/managedResources/index'
import { ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'
import { createHostWorkspaceFixture } from './hostWorkspaceFixture'

const sandbox = process.env.M2_SMOKE_SANDBOX!
const output = process.env.M2_SMOKE_OUTPUT!
if (!sandbox || !output) throw new Error('Isolated fixture directories are required')
app.setPath('userData', path.join(sandbox, 'electron-user-data'))
app.setName('cc-haha-m2-isolated-fixture')
const SENTINEL = 'M2_NATIVE_FIXTURE_SECRET_ONLY'
const steps: Array<{ name: string; status: 'passed' }> = []
const driverEvidence = { opened: 0, closed: 0, scans: 0 }
let win: BrowserWindow | undefined
let module: ReturnType<typeof createManagedResourcesModule> | undefined
let workspaceFixture: Awaited<ReturnType<typeof createHostWorkspaceFixture>> | undefined
let stage = 'startup'
const deadline = setTimeout(() => app.exit(2), 150_000)

async function waitFor(expression: string, label: string, timeout = 12_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await win!.webContents.executeJavaScript(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Fixture wait failed: ${label}`)
}
async function elementExpression(selector: string) {
  return `document.querySelector(${JSON.stringify(selector)})`
}
async function clickExpression(expression: string) {
  try {
    // Preference writes disable actions while committing. A native click must wait
    // for an enabled, visible target rather than silently clicking a disabled button.
    await waitFor(`(() => {
      const element = ${expression};
      if (!element || element.disabled || element.closest('[hidden], [inert]')) return false;
      element.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })()`, `click target: ${expression}`)
  } catch (error) {
    await fs.writeFile(path.join(output, 'click-failure.png'), (await win!.webContents.capturePage()).toPNG())
    throw error
  }
  const point = await win!.webContents.executeJavaScript(`(() => {
    const element = ${expression}; element.scrollIntoView({block:'center', inline:'center'});
    const box = element.getBoundingClientRect(); return {x: box.x+box.width/2, y: box.y+box.height/2};
  })()`)
  const driver = win!.webContents.debugger
  await driver.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await driver.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function clickButton(key: string, selector = 'button', scope = 'document') {
  return clickExpression(`Array.from(${scope}.querySelectorAll(${JSON.stringify(selector)})).find(element => (element.getAttribute('aria-label') || element.textContent.trim()) === window.m2Smoke.label(${JSON.stringify(key)}))`)
}
async function type(selector: string, value: string) {
  await clickExpression(await elementExpression(selector))
  // Trusted browser input, not assigned React state or a helper submit action.
  const driver = win!.webContents.debugger
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await driver.sendCommand('Input.insertText', { text: value })
}
async function snapshot() {
  const value = await win!.webContents.executeJavaScript('window.m2Smoke.snapshot()')
  assert.equal(JSON.stringify(value).includes(SENTINEL), false)
  return value
}
async function document() {
  const loaded = await module!.services.store.load()
  assert.equal(loaded.status, 'ready')
  if (loaded.status !== 'ready') throw new Error('Fixture resource read failed')
  return loaded.document
}
async function save() {
  await clickButton('common.save', 'button[type="submit"]')
  await waitFor('!document.querySelector("[role=dialog]")', 'saved dialog closes')
}

void app.whenReady().then(async () => {
  try {
    await fs.mkdir(output, { recursive: true })
    win = new BrowserWindow({ width: 1280, height: 960, show: false,
      webPreferences: { preload: path.join(sandbox, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // This fixture cannot reach any external endpoint or the user's local apps.
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(file:|data:|blob:)/.test(details.url) })
    })
    const exportPath = path.join(sandbox, 'fixture-export.json')
    const directorySelections: string[] = []
    // Explicit unavailable sidecar fixture: all HTTP is denied above. This
    // exercises the real tab-store fallback without contacting any local app.
    ipcMain.handle(ELECTRON_IPC_CHANNELS.getServerUrl, () => 'http://127.0.0.1:0')
    module = createManagedResourcesModule({
      ipcMain, getMainWindow: () => win ?? null, activeConfigDir: path.join(sandbox, 'config'), userDataDir: sandbox,
      dataBrowserAdapters: {
        async open(connection) {
          driverEvidence.opened += 1
          const close = async () => { driverEvidence.closed += 1 }
          if (connection.kind === 'database') return { kind: 'database', sql: {
            listDatabases: async () => [{ name: connection.database }], listSchemas: async () => [{ name: 'public' }],
            listTables: async schema => [{ schema, name: 'orders', kind: 'table' }],
            describeTable: async (schema, name) => ({ table: { schema, name, kind: 'table' }, columns: [{ ordinal: 1, name: 'id', dataType: 'bigint', nullable: false }] }),
            previewTable: async function* () { yield { columns: [{ name: 'id', dataType: 'bigint' }], rows: [['9007199254740993']] } },
            executeQuery: async function* () { yield { columns: [{ name: 'value' }], rows: [['native-query-result']] } },
            close,
          } }
          return { kind: 'redis', redis: {
            scan: async () => { driverEvidence.scans += 1; return { cursor: '0', keys: [Buffer.from('native:key')] } },
            type: async () => 'string', ttl: async () => 60,
            readString: async () => ({ value: Buffer.from('native-value'), byteLength: 12 }),
            scanHash: async () => ({ cursor: '0', entries: [] }), readList: async () => [],
            scanSet: async () => ({ cursor: '0', values: [] }), scanZSet: async () => ({ cursor: '0', values: [] }),
            readStream: async () => ({ nextCursor: null, values: [] }), close,
          } }
        },
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(`fixture-sealed:${value}`, 'utf8'),
        decryptString: value => {
          const text = value.toString('utf8')
          if (!text.startsWith('fixture-sealed:')) throw new Error('Fixture decrypt failed')
          return text.slice('fixture-sealed:'.length)
        },
      },
      dialogService: {
        showSaveDialog: async () => ({ canceled: false, filePath: exportPath }),
        showOpenDialog: async (_window, options) => {
          if (options.properties?.includes('openDirectory')) {
            const selected = directorySelections.shift()
            return { canceled: !selected, filePaths: selected ? [selected] : [] }
          }
          return { canceled: false, filePaths: [exportPath] }
        },
      },
    })
    workspaceFixture = await createHostWorkspaceFixture(module, sandbox, SENTINEL, directorySelections)
    await win.loadFile(path.join(sandbox, 'ui', 'index.html'))
    win.webContents.debugger.attach('1.3')
    await waitFor('Boolean(window.m2Smoke)', 'renderer bootstrap')
    stage = 'host entry and singleton'
    for (let i = 0; i < 10; i++) await clickButton('managedResources.title')
    await waitFor('Boolean(document.querySelector("[data-testid=hosts-workspace]"))', 'host route')
    assert.deepEqual((await snapshot()).tabs, ['__hosts__'])
    steps.push({ name: stage, status: 'passed' })

    stage = 'host form, two tags, and vault commit'
    await clickButton('common.add')
    await type('#host-name-input', 'Native fixture host')
    await type('#host-address-input', '127.0.0.1')
    await type('#host-port-input', String(workspaceFixture.port))
    await type('#host-username-input', 'fixture')
    await type('#host-initial-dir-input', '/workspace')
    await type('#host-password-input', SENTINEL)
    for (const name of ['Native tag A', 'Native tag B']) {
      await type('#host-new-tag', name)
      await clickButton('managedResources.addTag')
      await waitFor(`Array.from(document.querySelectorAll('[role=dialog] button[aria-pressed=true]')).some(button => button.textContent.trim() === ${JSON.stringify(name)})`, 'inline tag selection completes')
    }
    await snapshot()
    await save()
    const saved = await document()
    assert.equal(saved.hosts.length, 1)
    assert.equal(saved.hosts[0]!.tagIds.length, 2, 'both selected tags persist')
    assert.equal(saved.credentials.length, 1)
    assert.equal(saved.hosts[0]!.auth.credentialId, saved.credentials[0]!.id)
    assert.equal((await snapshot()).selectedHostId, saved.hosts[0]!.id)
    assert.equal((await fs.readFile(module.services.store.filePath, 'utf8')).includes(SENTINEL), false)
    steps.push({ name: stage, status: 'passed' })

    stage = 'native SSH single echo and side-by-side file editing'
    await workspaceFixture.verify(win, { clickButton, clickExpression, waitFor, type }, output)
    steps.push({ name: stage, status: 'passed' })

    if (process.env.M2_SMOKE_ONLY_HOST_FILES === '1') {
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', kind: 'isolated-native-host-files-editors-smoke', platform: process.platform, steps, testedAt: new Date().toISOString(), realServicesContacted: false, fakeVault: true }, null, 2) + '\n')
      await workspaceFixture.close()
      module.cleanup()
      clearTimeout(deadline)
      win.destroy()
      console.log('HOST_FILES_EDITORS_NATIVE_SMOKE passed; stages=' + steps.length)
      app.quit()
      return
    }

    stage = 'application account cancellation and atomic save'
    await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
    for (const cancel of [true, false]) {
      await clickButton('managedResources.newApplication')
      await type('#app-name-input', 'Native fixture application')
      await clickButton('managedResources.m2.addAccount')
      await type('#new-account-label', 'Native fixture account')
      await type('#new-account-username', 'fixture-user')
      await type('#new-account-password', SENTINEL)
      await clickButton('common.add', 'button', 'document.querySelector("[role=dialog]")')
      assert.equal((await document()).credentials.length, 1)
      await snapshot()
      if (cancel) {
        await clickButton('common.cancel')
        await waitFor('!document.querySelector("[role=dialog]")', 'cancel closes')
        assert.equal((await document()).hosts[0]!.applications.length, 0)
      } else await save()
    }
    assert.equal((await document()).credentials.length, 2)
    assert.equal((await document()).hosts[0]!.applications.length, 1)
    steps.push({ name: stage, status: 'passed' })

    stage = 'export and import public metadata'
    await clickButton('managedResources.importExport')
    await clickButton('managedResources.exportJson')
    await waitFor('Boolean(document.querySelector("[role=status]"))', 'export success')
    const exported = await fs.readFile(exportPath, 'utf8')
    assert.equal(exported.includes(SENTINEL), false)
    assert.equal(exported.includes(saved.credentials[0]!.id), false)
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[role=status]").textContent.includes("undefined")'), false)
    await clickButton('managedResources.importSelectFile')
    await waitFor('document.querySelector("[role=status]")?.textContent === window.m2Smoke.label("managedResources.m2.importComplete", {count:3})', 'import count')
    await clickButton('common.close', 'button', 'document.querySelector("[role=dialog]")')
    await waitFor('!document.querySelector("[role=dialog]")', 'import dialog closes')
    steps.push({ name: stage, status: 'passed' })

    stage = 'renderer reload and persisted singleton restoration'
    await win.loadFile(path.join(sandbox, 'ui', 'index.html'))
    await waitFor('window.m2Smoke?.snapshot().hosts.length === 1', 'reloaded resources')
    assert.deepEqual((await snapshot()).tabs, ['__hosts__'])
    assert.equal((await snapshot()).hosts[0].applications.length, 1)
    await clickExpression('document.querySelector("[data-testid=hosts-workspace] [role=button]")')
    win.showInactive()
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(output, 'host-workbench.png'), (await win.webContents.capturePage()).toPNG())
    steps.push({ name: stage, status: 'passed' })
    stage = 'data connection form and multiple tags through native IPC'
    await clickButton('managedResources.surface.dataConnections')
    await waitFor('Boolean(document.querySelector("[data-testid=data-connection-name]"))', 'data workspace')
    await type('[data-testid=data-connection-name]', 'Native fixture database')
    await type('[data-testid=data-connection-address]', 'fixture.invalid')
    await type('[data-testid=data-connection-database]', 'fixture_db')
    for (const name of ['Native DB A', 'Native DB B']) {
      await type('[data-testid=data-connection-new-tag]', name)
      await clickExpression('document.querySelector("[data-testid=data-connection-add-tag]")')
      await waitFor(`Array.from(document.querySelectorAll('label')).some(label => label.textContent.trim() === ${JSON.stringify(name)} && label.querySelector('input')?.checked)`, 'database tag committed')
    }
    await clickExpression('document.querySelector("[data-testid=save-data-connection]")')
    await waitFor('Boolean(document.querySelector("[data-testid=sql-query-panel]"))', 'database saved')
    assert.equal((await document()).dataConnections[0]!.tagIds.length, 2)
    assert.equal(driverEvidence.opened, 0, 'saving metadata must never connect')
    steps.push({ name: stage, status: 'passed' })

    stage = 'native SQL inspection and lossless preview'
    await clickExpression('document.querySelector("[data-testid=data-browser-connect]")')
    await waitFor('document.querySelector("[data-testid=sql-table]")?.value === "orders" && !document.querySelector("[data-testid=sql-preview]")?.disabled', 'connected table list')
    await clickExpression('document.querySelector("[data-testid=sql-preview]")')
    await waitFor('document.querySelector("[data-testid=sql-result-grid]")?.textContent.includes("9007199254740993")', 'lossless SQL value')
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=sql-execute]"))'), false)
    await fs.writeFile(path.join(output, 'sql-browser.png'), (await win.webContents.capturePage()).toPNG())
    await clickExpression('document.querySelector("[data-testid=data-browser-disconnect]")')
    await waitFor('Boolean(document.querySelector("[data-testid=data-browser-connect]"))', 'SQL disconnected')
    assert.equal(driverEvidence.closed, 1)
    steps.push({ name: stage, status: 'passed' })

    stage = 'native Redis explicit scan, TTL and bounded read'
    await clickExpression('document.querySelector("[data-testid=new-redis]")')
    await type('[data-testid=data-connection-name]', 'Native fixture Redis')
    await type('[data-testid=data-connection-address]', 'fixture.invalid')
    await clickExpression('document.querySelector("[data-testid=save-data-connection]")')
    await waitFor('Boolean(document.querySelector("[data-testid=redis-browser]"))', 'Redis saved')
    assert.equal(driverEvidence.scans, 0)
    await clickExpression('document.querySelector("[data-testid=data-browser-connect]")')
    await waitFor('Boolean(document.querySelector("[data-testid=redis-refresh]"))', 'Redis connected')
    assert.equal(driverEvidence.scans, 0)
    await clickExpression('document.querySelector("[data-testid=redis-refresh]")')
    await clickExpression('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "native:key")')
    await waitFor('Boolean(document.querySelector("[data-testid=redis-value]"))', 'Redis value')
    assert.equal(driverEvidence.scans, 1)
    await fs.writeFile(path.join(output, 'redis-browser.png'), (await win.webContents.capturePage()).toPNG())
    await clickExpression('document.querySelector("[data-testid=data-browser-disconnect]")')
    await waitFor('Boolean(document.querySelector("[data-testid=data-browser-connect]"))', 'Redis disconnected')
    assert.equal(driverEvidence.closed, 2)
    assert.equal((await fs.readFile(module.services.store.filePath, 'utf8')).includes('native-value'), false)
    steps.push({ name: stage, status: 'passed' })

    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', kind: 'isolated-native-electron-feature-smoke', platform: process.platform, electron: process.versions.electron, testedAt: new Date().toISOString(), steps, driverEvidence, realServicesContacted: false, fakeVault: true, mockDatabaseDrivers: true }, null, 2) + '\n')
    await workspaceFixture.close()
    console.log('M2_NATIVE_SMOKE passed; stages=' + steps.length)
    module.cleanup()
    clearTimeout(deadline)
    win.destroy()
    app.quit()
  } catch (error) {
    // Diagnostics deliberately exclude inputs, screenshots of password forms,
    // resource records, vault values, and renderer console content.
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', stage, kind: 'isolated-native-electron-feature-smoke', errorType: error instanceof Error ? error.name : 'unknown', steps, testedAt: new Date().toISOString() }, null, 2) + '\n')
    console.error('M2_NATIVE_SMOKE failed at ' + stage + ': ' + (error instanceof Error ? error.message.replaceAll(SENTINEL, '[FIXTURE_REDACTED]') : 'unknown'))
    await workspaceFixture?.close()
    module?.cleanup()
    clearTimeout(deadline)
    win?.destroy()
    app.exit(1)
  }
})
