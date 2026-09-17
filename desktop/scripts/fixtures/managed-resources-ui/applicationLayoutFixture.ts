import { verifyApplicationSearch } from './applicationSearchFixture'
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

/** Exercise the production application form, IPC-backed listings and native disclosure controls. */
export async function verifyApplicationLayout(win: BrowserWindow, controls: Controls, remote: FakeSftpTransport, output: string) {
  const { clickButton, clickExpression, waitFor, type } = controls
  const root = '/workspace/application-layout'
  for (const [file, contents] of [
    ['apps/data/keep.txt', 'fixture'], ['apps/application.jar', 'fixture'],
    ['conf/nested/config.conf', 'fixture=true'], ['conf/app.conf', 'fixture=true'],
    ['logs/server.log', 'fixture log'], ['bin/bin/start.sh', '# fixture, never execute'],
  ]) await remote.seedFile(`${root}/${file}`, contents!)
  for (let i = 0; i < 24; i++) await remote.seedFile(`${root}/apps/entry-${i}.jar`, 'fixture')
  const originalSize = win.getContentSize()
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await clickButton('managedResources.newApplication')
  await type('#app-name-input', 'Layout fixture application')
  await type('#app-install-paths-input', root)
  await clickButton('common.save', 'button[type="submit"]')
  await waitFor('!document.querySelector("[role=dialog]")', 'application saved')
  await waitFor('document.querySelectorAll("[data-app-directory] [role=list]").length === 4', 'four real directory lists')
  const panel = (directory: string) => `document.querySelector('[data-app-directory="${directory}"]')`
  const toggle = (directory: string) => `${panel(directory)}.querySelector('button[aria-expanded]')`
  const geometry = () => win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('[data-testid=application-file-lists]');
    const scroller = document.querySelector('[data-testid=application-file-lists-scroll]');
    return { display: getComputedStyle(grid).display, columns: getComputedStyle(grid).gridTemplateColumns,
      width: innerWidth, pageWidth: document.documentElement.scrollWidth,
      clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth,
      overflow: getComputedStyle(scroller).overflowX,
      panels: Array.from(grid.querySelectorAll('[data-app-directory]')).map(element => {
        const button = element.querySelector('button[aria-expanded]');
        const body = document.getElementById(button.getAttribute('aria-controls'));
        const list = body.querySelector('[role=list]');
        return { name: element.dataset.appDirectory, ...element.getBoundingClientRect().toJSON(),
          expanded: button.getAttribute('aria-expanded'), bodyHeight: body.getBoundingClientRect().height,
          listOverflow: list && getComputedStyle(list).overflowY,
          scrolls: list && list.scrollHeight > list.clientHeight };
      }) };
  })()`)
  const evidence: Record<string, unknown> = {}
  try {
    for (const width of [1440, 1024]) {
      win.setContentSize(width, 900)
      await waitFor(`innerWidth === ${width}`, 'viewport resize')
      const layout = await geometry()
      assert.equal(layout.display, 'grid')
      assert.deepEqual(layout.panels.map((p: { name: string }) => p.name), ['apps', 'conf', 'logs', 'bin/bin'])
      layout.panels.forEach((p: { top: number; left: number; width: number }, i: number) => {
        assert.ok(Math.abs(p.top - layout.panels[0].top) < 2, 'four panels share one top edge')
        assert.ok(p.width >= 239, 'panel retains a usable width')
        if (i) assert.ok(p.left >= layout.panels[i - 1].right, 'panels never overlap')
      })
      assert.equal(layout.overflow, 'auto')
      assert.ok(layout.pageWidth <= layout.width + 1, 'overflow remains inside the lists, not the page')
      assert.equal(layout.panels[0].listOverflow, 'auto')
      assert.equal(layout.panels[0].scrolls, true)
      if (width === 1024) assert.ok(layout.scrollWidth > layout.clientWidth, 'narrow viewport scrolls horizontally')
      evidence[`width${width}`] = layout
    }
    win.setContentSize(1440, 900)
    await waitFor('innerWidth === 1440', 'wide viewport restored')
    await win.webContents.executeJavaScript('document.querySelector("[data-testid=application-file-lists-scroll]").scrollIntoView({block:"center"})')
    await fs.writeFile(path.join(output, 'application-lists-expanded.png'), (await win.webContents.capturePage()).toPNG())
    await clickExpression(toggle('conf'))
    await waitFor(`${toggle('conf')}.getAttribute('aria-expanded') === 'false'`, 'conf collapsed')
    const collapsed = await geometry()
    assert.equal(collapsed.panels[1].bodyHeight, 0)
    assert.equal(collapsed.panels[1].width, 48, 'collapse reclaims horizontal width')
    assert.ok(Math.abs(collapsed.panels[1].height - collapsed.panels[0].height) < 2, 'collapsed title rail retains the column height')
    assert.ok(collapsed.panels[0].width > 242.5, 'expanded neighbours take the released width')
    assert.deepEqual(collapsed.panels.map((p: { expanded: string }) => p.expanded), ['true', 'false', 'true', 'true'])
    evidence.collapsed = collapsed
    await fs.writeFile(path.join(output, 'application-lists-collapsed.png'), (await win.webContents.capturePage()).toPNG())
    // The disclosure is a native button: Enter and Space must actually activate it.
    for (const [key, code, keyCode, expanded] of [['Enter', 'Enter', 13, 'true'], [' ', 'Space', 32, 'false']] as const) {
      await win.webContents.executeJavaScript(`${toggle('conf')}.focus()`)
      assert.equal(await win.webContents.executeJavaScript(`document.activeElement === ${toggle('conf')}`), true)
      // Chromium needs the generated text too, not only virtual-key metadata,
      // to dispatch the native button's default activation (Enter/Space).
      const text = key === 'Enter' ? '\r' : ' '
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
      await waitFor(`${toggle('conf')}.getAttribute('aria-expanded') === '${expanded}'`, `native disclosure keyboard activation: ${code}`)
    }
    await clickExpression(toggle('conf'))
    await clickExpression(`Array.from(${panel('conf')}.querySelectorAll('button')).find(button => button.textContent.trim() === 'nested')`)
    await waitFor(`${panel('conf')}.textContent.includes('config.conf')`, 'nested navigation')
    await clickExpression(toggle('conf'))
    await clickExpression(toggle('conf'))
    assert.equal(await win.webContents.executeJavaScript(`${panel('conf')}.textContent.includes('${root}/conf/nested')`), true)
    await clickExpression(toggle('apps'))
    await win.webContents.executeJavaScript(`window.applicationFullscreenGrid = document.querySelector('[data-testid=application-file-lists]')`)
    await clickButton('managedResources.appOperations.fullScreen')
    await waitFor('document.querySelector("[data-testid=application-workspace]").dataset.fullscreen === "true"', 'workspace maximized')
    const fullscreen = await win.webContents.executeJavaScript(`(() => {
      const frame = document.querySelector('[data-testid=application-workspace]');
      const box = frame.getBoundingClientRect();
      const list = document.querySelector('[data-app-directory="logs"] [role=list]');
      return { ...box.toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight, listHeight: list.clientHeight,
        gridPreserved: window.applicationFullscreenGrid === document.querySelector('[data-testid=application-file-lists]'),
        backgroundInert: document.getElementById('root')?.hasAttribute('inert') ?? Array.from(document.body.children).some(element => element.hasAttribute('inert')) };
    })()`)
    assert.equal(fullscreen.x, 0)
    assert.equal(fullscreen.y, 0)
    assert.equal(fullscreen.width, fullscreen.viewportWidth)
    assert.equal(fullscreen.height, fullscreen.viewportHeight)
    assert.equal(fullscreen.gridPreserved, true)
    assert.equal(fullscreen.backgroundInert, true)
    assert.ok(fullscreen.listHeight > 600, 'maximized lists use the available screen height')
    assert.equal(await win.webContents.executeJavaScript(`${toggle('apps')}.getAttribute('aria-expanded')`), 'false')
    assert.equal(await win.webContents.executeJavaScript(`${panel('conf')}.textContent.includes('${root}/conf/nested')`), true)
    evidence.fullscreen = fullscreen
    await fs.writeFile(path.join(output, 'application-fullscreen.png'), (await win.webContents.capturePage()).toPNG())
    const escape = async () => {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await clickExpression(`Array.from(${panel('conf')}.querySelectorAll('button')).find(button => button.textContent.trim() === 'config.conf')`)
    await waitFor('Boolean(document.querySelector("[role=dialog] pre"))', 'viewer opens above fullscreen')
    assert.equal(await win.webContents.executeJavaScript(`(() => { const dialog = document.querySelector('[role=dialog]'); const box = dialog.getBoundingClientRect(); return dialog.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })()`), true)
    await escape()
    await waitFor('!document.querySelector("[role=dialog]")', 'Escape closes only viewer')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid=application-workspace]').dataset.fullscreen`), 'true')
    await escape()
    await waitFor('document.querySelector("[data-testid=application-workspace]").dataset.fullscreen === "false"', 'Escape restores workspace')
    assert.equal(await win.webContents.executeJavaScript(`window.applicationFullscreenGrid === document.querySelector('[data-testid=application-file-lists]')`), true)
    assert.equal(await win.webContents.executeJavaScript(`${panel('conf')}.textContent.includes('${root}/conf/nested')`), true)
    assert.equal(await win.webContents.executeJavaScript(`document.activeElement?.getAttribute('aria-label') === window.m2Smoke.label('managedResources.appOperations.fullScreen')`), true)
    await clickButton('managedResources.appOperations.fullScreen')
    await clickButton('managedResources.appOperations.restore')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid=application-workspace]').dataset.fullscreen`), 'false')
    await fs.writeFile(path.join(output, 'application-restored.png'), (await win.webContents.capturePage()).toPNG())
    await verifyApplicationSearch(win, controls, remote, root, output)
    evidence.searchAndPins = true
    evidence.restoredWithoutRemount = true
    evidence.nestedDialogEscape = true
    await fs.writeFile(path.join(output, 'application-layout.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), ...evidence, nativeKeyboard: true, navigationPreserved: true, realCredentials: false, fakeSftp: true }, null, 2) + '\n')
  } finally {
    if (await win.webContents.executeJavaScript(`document.querySelector('[data-testid=application-workspace]')?.dataset.fullscreen === 'true'`)) {
      await clickButton('managedResources.appOperations.restore')
    }
    win.setContentSize(originalSize[0]!, originalSize[1]!)
    // This fixture created the only application; leave the enclosing smoke's repository clean.
    await clickButton('managedResources.deleteApp')
    await clickButton('common.delete', 'button', 'document.querySelector("[role=dialog]")')
    await waitFor('!document.querySelector("[data-testid=application-file-lists]")', 'fixture application removed')
  }
}
