import { describe, expect, it } from 'vitest'
import { ELECTRON_IPC_CHANNELS } from './channels'
import {
  ELECTRON_IPC_VALIDATORS,
  isElectronIpcChannel,
  validateElectronIpcPayload,
} from './capabilities'

describe('Electron IPC capabilities', () => {
  it('has a validator for every exposed invoke channel', () => {
    expect(Object.keys(ELECTRON_IPC_VALIDATORS).sort()).toEqual(
      Object.values(ELECTRON_IPC_CHANNELS).sort(),
    )
  })

  it('rejects channels outside the desktop host contract', () => {
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetVersion)).toBe(true)
    expect(isElectronIpcChannel('ipcRenderer:send-anything')).toBe(false)
  })

  it('validates structured payloads before they reach ipcRenderer.invoke', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, { url: 'https://example.com' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.traceOpenWindow, '4673a448-9e2c-475e-898d-9aa0ee2d1ab7')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.traceOpenWindow, '../escape')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, { deltaX: 4, deltaY: -2 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1, data: 'pwd\n' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: '1', data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: '/tmp' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: '80', rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890', extra: true })).toBe(false)
  })
})
