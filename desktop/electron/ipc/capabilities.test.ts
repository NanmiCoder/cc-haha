import { describe, expect, it } from 'vitest'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'
import { ELECTRON_IPC_CHANNELS } from './channels'
import {
  ELECTRON_IPC_VALIDATORS,
  isElectronIpcChannel,
  isElectronIpcChannelAllowedForPetWindow,
  validateElectronIpcPayload,
} from './capabilities'

describe('Electron IPC capabilities', () => {
  it('restricts public access credentials and consent to validated desktop IPC', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.publicAccessSaveCredential, 'fake-token')).toBe(true)
    for (const value of ['', 'a b', 'x'.repeat(4097), {}, null]) {
      expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.publicAccessSaveCredential, value)).toBe(false)
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.publicAccessStart, PUBLIC_ACCESS_CONSENT_VERSION)).toBe(true)
    for (const value of [0, PUBLIC_ACCESS_CONSENT_VERSION - 1, PUBLIC_ACCESS_CONSENT_VERSION + 1, '2', null]) {
      expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.publicAccessStart, value)).toBe(false)
    }
    for (const channel of Object.values(ELECTRON_IPC_CHANNELS).filter(value => value.startsWith('desktop:public-access:'))) {
      expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    }
  })

  it('accepts only the typed browser-menu fields and keeps the channel unavailable to pets', () => {
    const channel = ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu
    const labels = Object.fromEntries(['find', 'print', 'zoom', 'zoomIn', 'zoomOut', 'zoomReset', 'capture', 'pickElement', 'downloads', 'history', 'openExternal'].map(key => [key, key]))
    const payload = { tabId: 'wb-1', x: 20, y: 44, labels, zoomFactor: 1, hasPage: true, canOpenExternal: true }
    expect(validateElectronIpcPayload(channel, payload)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    for (const patch of [
      { tabId: '' }, { tabId: '../bad' }, { x: NaN }, { y: Infinity }, { x: '20' },
      { zoomFactor: 0 }, { zoomFactor: NaN }, { canOpenExternal: 'true' }, { hasPage: undefined }, { hasPage: 'true' },
      { action: 'quit' }, { labels: { ...labels, role: 'quit' } },
      { labels: { ...labels, find: undefined } }, { labels: { ...labels, find: '' } },
      { labels: { ...labels, find: 'x'.repeat(201) } }, { labels: { ...labels, find: 'bad\nlabel' } },
    ]) expect(validateElectronIpcPayload(channel, { ...payload, ...patch })).toBe(false)
  })

  it('accepts optional initial browser visibility without widening the create payload', () => {
    const channel = ELECTRON_IPC_CHANNELS.workspaceBrowserCreate
    const identity = { tabId: 'wb-1', storageId: 'store-1' }
    expect(validateElectronIpcPayload(channel, identity)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...identity, visible: false })).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...identity, visible: true })).toBe(true)
    for (const visible of ['false', 0, null, {}]) {
      expect(validateElectronIpcPayload(channel, { ...identity, visible })).toBe(false)
    }
    expect(validateElectronIpcPayload(channel, { ...identity, visible: false, unknown: true })).toBe(false)
  })

  it('has a validator for every exposed invoke channel', () => {
    expect(Object.keys(ELECTRON_IPC_VALIDATORS).sort()).toEqual(
      Object.values(ELECTRON_IPC_CHANNELS).sort(),
    )
  })

  it('limits presentation snapshots to a single browser page id', () => {
    const channel = ELECTRON_IPC_CHANNELS.workspaceBrowserSnapshot
    expect(validateElectronIpcPayload(channel, { tabId: 'wb-1' })).toBe(true)
    for (const payload of [{}, { tabId: '' }, { tabId: 'wb-1', kind: 'full' }, { tabId: 'wb-1', url: 'https://example.com' }]) {
      expect(validateElectronIpcPayload(channel, payload)).toBe(false)
    }
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })

  it('rejects channels outside the desktop host contract', () => {
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetVersion)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetLocalePreference)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appSetLocalePreference)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages)).toBe(true)
    expect(isElectronIpcChannel('ipcRenderer:send-anything')).toBe(false)
  })

  it('validates structured payloads before they reach ipcRenderer.invoke', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, { url: 'https://example.com' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardReadText, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, 'paste me')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, { text: 'paste me' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.traceOpenWindow, '4673a448-9e2c-475e-898d-9aa0ee2d1ab7')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.traceOpenWindow, '../escape')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, { deltaX: 4, deltaY: -2 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1, data: 'pwd\n' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: '1', data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: '/tmp' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, requestId: 'start' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { requestId: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { requestId: 'x'.repeat(129) })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: '80', rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, shell: '/bin/sh' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: Number.NaN, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80.5, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 1_001, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: Number.POSITIVE_INFINITY })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: 'x'.repeat(4_097) })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 0, data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1.5, data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: Number.MAX_SAFE_INTEGER + 1,
      data: 'pwd\n',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: 1,
      data: 'x'.repeat(1_048_577),
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: 1,
      data: 'pwd\n',
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalResize, {
      sessionId: 1,
      cols: 80,
      rows: 24,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalResize, {
      sessionId: 1,
      cols: Number.NaN,
      rows: 24,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalKill, { sessionId: -1 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalKill, {
      sessionId: 1,
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890', extra: true })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appSetLocalePreference, 'zh-TW')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appSetLocalePreference, 'fr')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsList, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsList, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      dialogTitle: '选择透明背景的宠物图片',
      dialogFilterName: '宠物图片',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      dialogTitle: 'Bad\nTitle',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: '../escape',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      atlasPath: '/tmp/private.png',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsOpenFolder, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShow, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsHide, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: '关闭宠物',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: '   ',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'x'.repeat(81),
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close\nPet',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close pet',
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: -1_240.5,
      y: 480,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: Number.NaN,
      y: 480,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'teleport',
      x: 120,
      y: 480,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'end',
      x: 120,
      y: 480,
      windowId: 2,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: 100, y: 220, width: 144, height: 160 },
    ])).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: -1, y: 0, width: 20, height: 20 },
    ])).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, 'session-123')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, '../escape')).toBe(false)
  })

  it('pins the reported appearance colors to literal 6-digit hex', () => {
    // Both values reach BrowserWindow.setBackgroundColor, which also accepts
    // #AARRGGBB — an 8-digit value would let a compromised renderer make the
    // window translucent (click-through, overlay spoofing). So the boundary
    // takes exactly #RRGGBB and nothing else.
    const valid = {
      isDark: true,
      background: '#0E0E0E',
      lightBackground: '#FFFFFF',
      followSystem: false,
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appearanceSetApplied, valid)).toBe(true)

    for (const invalid of [
      undefined,
      'dark',
      { isDark: true, background: '#0E0E0E', lightBackground: '#FFFFFF' },
      { isDark: true, background: '#0E0E0E', followSystem: false },
      { isDark: 'true', background: '#0E0E0E', lightBackground: '#FFFFFF', followSystem: false },
      { ...valid, background: '#0E0' },
      { ...valid, background: 'black' },
      { ...valid, background: 'rgb(0 0 0)' },
      { ...valid, background: '#800E0E0E' },
      { ...valid, lightBackground: '#80FFFFFF' },
      { ...valid, lightBackground: 'white' },
      { ...valid, extra: 1 },
    ]) {
      expect(
        validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appearanceSetApplied, invalid),
        JSON.stringify(invalid),
      ).toBe(false)
    }
  })

  it('keeps the appearance channel away from the pet window', () => {
    // The pet window is transparent and must not repaint the main window.
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appearanceSetApplied,
    )).toBe(false)
  })

  it('gives the pet renderer only runtime bootstrap and companion controls', () => {
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appGetLocalePreference,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appSetLocalePreference,
    )).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetServerUrl,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
    )).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsList)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsHide)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsShowContextMenu,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsDragWindow,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsFocusSession)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsFocusMainWindow,
    )).toBe(true)

    for (const forbidden of [
      ELECTRON_IPC_CHANNELS.commandInvoke,
      ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
      ELECTRON_IPC_CHANNELS.shellOpen,
      ELECTRON_IPC_CHANNELS.shellOpenPath,
      ELECTRON_IPC_CHANNELS.dialogOpen,
      ELECTRON_IPC_CHANNELS.petsCreateFromImage,
      ELECTRON_IPC_CHANNELS.petsCreateFromAtlas,
      ELECTRON_IPC_CHANNELS.updateRelaunch,
      ELECTRON_IPC_CHANNELS.terminalSpawn,
      ELECTRON_IPC_CHANNELS.previewOpen,
      ELECTRON_IPC_CHANNELS.appModeSet,
      ELECTRON_IPC_CHANNELS.adaptersRestartSidecar,
    ]) {
      expect(isElectronIpcChannelAllowedForPetWindow(forbidden)).toBe(false)
    }
  })
})
